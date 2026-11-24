---
title: "How Many Threads Can Java Create?"
description: "How many threads can a Java process create, and how deep can a stack go? Tracing from JVM source to glibc and the kernel through memory, process limits, max_map_count and pid_max, verified with experiments."
pubDate: 2022-03-21
tags: ["Java", "Linux"]
---

> While discussing recommended JVM settings for Java apps running in Kubernetes containers with colleagues, we quickly agreed on the heap but got fuzzy on the stack. This post records what I found about Java thread stack memory and the limits around it.

1. How many threads can Java create at most, and what limits it?
2. How deep can a Java thread's stack go?

## How many threads can Java create?

Java threads map 1:1 to Linux threads. In Java, `new Thread()` creates a Java thread object and `Thread().start()` starts it, but `new Thread()` does not create a real Linux thread; only calling `start()` does. The Thread constructor is pure Java code, while `start()` calls the native method `start0`, which is in fact `JVM_StartThread`:

Source: openjdk 1.8 · `jdk/src/hotspot/share/prims/jvm.cpp#2634`

```
JVM_ENTRY(void, JVM_StartThread(JNIEnv* env, jobject jthread))
  ...
      jlong size =
             java_lang_Thread::stackSize(JNIHandles::resolve_non_null(jthread));
      
      size_t sz = size > 0 ? (size_t) size : 0;
      native_thread = new JavaThread(&thread_entry, sz);

      ...
      
  if (native_thread->osthread() == NULL) {
    ...
    THROW_MSG(vmSymbols::java_lang_OutOfMemoryError(),
              "unable to create new native thread");
  }

  Thread::start(native_thread);

JVM_END
```

Note the final if check, `if (native_thread->osthread() == NULL)`. If osthread is null, the JVM throws the familiar `unable to create new native thread` OOM error. So osthread being null is the key, and we'll see below when that happens.

Also note `native_thread = new JavaThread(&thread_entry, sz)`: this is where the thread is actually created.

Source: openjdk 1.8 · `jdk/src/hotspot/share/runtime/thread.cpp#1443`

```cpp
JavaThread::JavaThread(ThreadFunction entry_point, size_t stack_sz) :
  Thread()
#ifndef SERIALGC
  , _satb_mark_queue(&_satb_mark_queue_set),
  _dirty_card_queue(&_dirty_card_queue_set)
#endif // !SERIALGC
{
  if (TraceThreadEvents) {
    tty->print_cr("creating thread %p", this);
  }
  initialize();
  _jni_attach_state = _not_attaching_via_jni;
  set_entry_point(entry_point);
  // Create the native thread itself.
  // %note runtime_23
  os::ThreadType thr_type = os::java_thread;
  thr_type = entry_point == &compiler_thread_entry ? os::compiler_thread :
                                                     os::java_thread;
  os::create_thread(this, thr_type, stack_sz);
}
```

`os::create_thread(this, thr_type, stack_sz)` in the code above creates the thread through `pthread_create`. The corresponding code:

Source: openjdk 1.8 · `jdk/src/hotspot/os/linux/os_linux.cpp#891`

```
bool os::create_thread(Thread* thread, ThreadType thr_type, size_t stack_size) {
  assert(thread->osthread() == NULL, "caller responsible");

  // Allocate the OSThread object
  OSThread* osthread = new OSThread(NULL, NULL);
  if (osthread == NULL) {
    return false;
  }

  // set the correct thread state
  osthread->set_thread_type(thr_type);

  // Initial state is ALLOCATED but not INITIALIZED
  osthread->set_state(ALLOCATED);

  thread->set_osthread(osthread);

  // init thread attributes
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  // stack size
  if (os::Linux::supports_variable_stack_size()) {
    // calculate stack size if it's not specified by caller
    if (stack_size == 0) {
      stack_size = os::Linux::default_stack_size(thr_type);

      switch (thr_type) {
      case os::java_thread:
        // Java threads use ThreadStackSize which default value can be
        // changed with the flag -Xss
        assert (JavaThread::stack_size_at_create() > 0, "this should be set");
        stack_size = JavaThread::stack_size_at_create();
        break;
      case os::compiler_thread:
        if (CompilerThreadStackSize > 0) {
          stack_size = (size_t)(CompilerThreadStackSize * K);
          break;
        } // else fall through:
          // use VMThreadStackSize if CompilerThreadStackSize is not defined
      case os::vm_thread:
      case os::pgc_thread:
      case os::cgc_thread:
      case os::watcher_thread:
        if (VMThreadStackSize > 0) stack_size = (size_t)(VMThreadStackSize * K);
        break;
      }
    }

    stack_size = MAX2(stack_size, os::Linux::min_stack_allowed);
    pthread_attr_setstacksize(&attr, stack_size);
  } else {
    // let pthread_create() pick the default value.
  }

  // glibc guard page
  pthread_attr_setguardsize(&attr, os::Linux::default_guard_size(thr_type));

  ThreadState state;

  {
    // Serialize thread creation if we are running with fixed stack LinuxThreads
    bool lock = os::Linux::is_LinuxThreads() && !os::Linux::is_floating_stack();
    if (lock) {
      os::Linux::createThread_lock()->lock_without_safepoint_check();
    }

    pthread_t tid;
    int ret = pthread_create(&tid, &attr, (void* (*)(void*)) java_start, thread);

    pthread_attr_destroy(&attr);

    if (ret != 0) {
      if (PrintMiscellaneous && (Verbose || WizardMode)) {
        perror("pthread_create()");
      }
      // Need to clean up stuff we've allocated so far
      thread->set_osthread(NULL);
      delete osthread;
      if (lock) os::Linux::createThread_lock()->unlock();
      return false;
    }

    // Store pthread info into the OSThread
    osthread->set_pthread_id(tid);
    ...
  }

  ...
  return true;
}
```

If `new OSThread` itself fails, osthread is obviously NULL, and back in the first snippet the JVM throws `java.lang.OutOfMemoryError: unable to create new native thread`. When does `new OSThread` fail? For example, when memory runs out. This memory is the C heap, not the Java heap, meaning the free memory left on Linux. So from the JVM's point of view, the factors that affect thread creation include Xmx, MaxPermSize, MaxDirectMemorySize, ReservedCodeCacheSize and so on, because they all affect how much memory is left.

Also, if `pthread_create` fails, `thread->set_osthread(NULL)` sets the value to null, so osthread is NULL again, the same OOM error is thrown, and thread creation fails. Next, let's look at what makes `pthread_create` fail.

### glibc

pthread_create is implemented in glibc.

glibc

glibc/sysdeps/unix/sysv/linux/createthread.c#624

```cpp
int
__pthread_create_2_1 (pthread_t *newthread, const pthread_attr_t *attr,
                      void *(*start_routine) (void *), void *arg)
{
  STACK_VARIABLES;
  const struct pthread_attr *iattr = (struct pthread_attr *) attr;
  struct pthread_attr default_attr;
  ...
  struct pthread *pd = NULL;
  int err = ALLOCATE_STACK (iattr, &pd);
  int retval = 0;
  if (__glibc_unlikely (err != 0))
    {
      retval = err == ENOMEM ? EAGAIN : err;
      goto out;
    }
  ...
 }
```

The key line here is `int err = ALLOCATE_STACK (iattr, &pd)`. As the name suggests, it allocates the thread stack: put simply, it uses mmap to allocate a block of memory of the stackSize given in iattr, to be used as the thread's stack.

About stackSize: a thread needs some stack space to run. Imagine there isn't enough memory when the stack is allocated; creation is bound to fail. In the JVM, stackSize can be set with -Xss, and there is a default if it isn't set. Here are the defaults since JDK 6:

Source: openjdk 1.8 · `jdk/src/hotspot/os_cpu/linux_x86/os_linux_x86.cpp#494`

```cpp
// return default stack size for thr_type
size_t os::Posix::default_stack_size(os::ThreadType thr_type) {
  // default stack size (compiler thread needs larger stack)
#ifdef AMD64
  size_t s = (thr_type == os::compiler_thread ? 4 * M : 1 * M);
#else
  size_t s = (thr_type == os::compiler_thread ? 2 * M : 512 * K);
#endif // AMD64
  return s;
}
```

Many people probably wonder whether stack memory is part of the Java heap controlled by -Xmx. It is not. So judging from this glibc logic, -Xss in the JVM, i.e. stack_size, is also a very important factor in thread creation.

Linux

If the stack is allocated successfully, the thread is created next. The logic is roughly:

Source: openjdk 1.8 · `jdk/src/hotspot/os/linux/os_linux.cpp#891`

```cpp
static int create_thread (struct pthread *pd, const struct pthread_attr *attr,
        bool *stopped_start, void *stackaddr,
        size_t stacksize, bool *thread_ran)
{
  struct clone_args args =
    {
      .flags = clone_flags,
      .pidfd = (uintptr_t) &pd->tid,
      .parent_tid = (uintptr_t) &pd->tid,
      .child_tid = (uintptr_t) &pd->tid,
      .stack = (uintptr_t) stackaddr,
      .stack_size = stacksize,
      .tls = (uintptr_t) tp,
    };
  int ret = __clone_internal (&args, &start_thread, pd);
  if (__glibc_unlikely (ret == -1))
    return errno;
 ...
}
```

create_thread actually invokes the clone system call, which ultimately calls `do_fork`. Let's dissect that method to see what other limits exist in the kernel.

max_user_process

Source: linux 3.10 · `kernel/fork.c#1199`

```
  retval = -EAGAIN;
  if (atomic_read(&p->real_cred->user->processes) >=
      task_rlimit(p, RLIMIT_NPROC)) {
    if (!capable(CAP_SYS_ADMIN) && !capable(CAP_SYS_RESOURCE) &&
        p->real_cred->user != INIT_USER)
      goto bad_fork_free;
  }
```

First, this part checks how many processes the user has. On Linux, processes and threads share the same data structure, so "processes" here can be read as lightweight threads. The maximum can be seen with `ulimit -u`, so if the current user already runs more threads than this limit, thread creation will certainly fail.

max_map_count

This path also involves malloc calls, implemented underneath with the brk system call, and, as mentioned above, the stack is allocated with mmap. Both malloc and mmap perform a similar check underneath:

Source: linux 3.10 · `mm/mmap.c#2480`

```
if (mm->map_count >= sysctl_max_map_count)
    return -ENOMEM;
```

If a process has more memory mappings than `sysctl_max_map_count`, the call fails. On Linux this value is `/proc/sys/vm/max_map_count`, which defaults to 65530 and can be changed by editing that file.

max_threads

Source: linux 3.10 · `kernel/fork.c#1217`

```
  /*
   * If multiple threads are within copy_process(), then this check
   * triggers too late. This doesn't hurt, the check is only there
   * to stop root fork bombs.
   */
  retval = -EAGAIN;
  if (nr_threads >= max_threads)
    goto bad_fork_cleanup_count;
```

This is the system-wide maximum number of threads (including non-JVM processes). You can view and change it at /proc/sys/kernel/threads-max. It is limited by physical memory and computed in `fork_init`, so the more memory the host has, the larger it is.

Source: linux 3.10 · `kernel/fork.c#267`

```js
  /*
   * The default maximum number of threads is set to a safe
   * value: the thread structures can take up at most half
   * of memory.
   */
  max_threads = mempages / (8 * THREAD_SIZE / PAGE_SIZE);

  /*
   * we need to allow at least 20 threads to boot a system
   */
  if (max_threads < 20)
    max_threads = 20;
```

pid_max

PIDs are limited too.

Source: linux 3.10 · `kernel/fork.c#1350`

```
  if (pid != &init_struct_pid) {
    retval = -ENOMEM;
    pid = alloc_pid(p->nsproxy->pid_ns);
    if (!pid)
      goto bad_fork_cleanup_io;
  }
```

`alloc_pid` is defined as follows:

Source: linux 3.10 · `kernel/pid.c#287`

```properties
struct pid *alloc_pid(struct pid_namespace *ns)
{
  struct pid *pid;
  enum pid_type type;
  int i, nr;
  struct pid_namespace *tmp;
  struct upid *upid;

  pid = kmem_cache_alloc(ns->pid_cachep, GFP_KERNEL);
  if (!pid)
    goto out;

  tmp = ns;
  pid->level = ns->level;
  for (i = ns->level; i >= 0; i--) {
    nr = alloc_pidmap(tmp);
    if (nr < 0)
      goto out_free;

    pid->numbers[i].nr = nr;
    pid->numbers[i].ns = tmp;
    tmp = tmp->parent;
  }

  ...
}
```

`alloc_pidmap` checks `pid_max`, which is defined as:

Source: linux 3.10 · `include/linux/threads.h#27`

```
/*
 * This controls the default maximum pid allocated to a process
 */
#define PID_MAX_DEFAULT (CONFIG_BASE_SMALL ? 0x1000 : 0x8000)

/*
 * A maximum of 4 million PIDs should be enough for a while.
 * [NOTE: PID/TIDs are limited to 2^29 ~= 500+ million, see futex.h.]
 */
#define PID_MAX_LIMIT (CONFIG_BASE_SMALL ? PAGE_SIZE * 8 : \
  (sizeof(long) > 4 ? 4 * 1024 * 1024 : PID_MAX_DEFAULT))
```

Source: linux 3.10 · `kernel/pid.c#48`

```
int pid_max = PID_MAX_DEFAULT;

#define RESERVED_PIDS    300

int pid_max_min = RESERVED_PIDS + 1;
int pid_max_max = PID_MAX_LIMIT;
```

You can view or change this value at `/proc/sys/kernel/pid_max`.

### Summary

From reading the JVM, glibc and Linux kernel source, we can draw some preliminary conclusions:

- Java thread stacks use the system's available memory; they are not managed by the JVM heap or non-heap.
- The default Java thread stack size is 1 MB, and changing it is one of the factors that determine how many threads you can create.
- Kernel-level factors include:

## How deep can a Java thread's stack go?

The stack structure inside a thread looks like this:

![](/images/java-max-threads/1.jpg)

Each stack frame holds the local variable table, operand stack, dynamic linking info, return address and so on. In other words, the deeper the call stack, the more frames there are, and the more memory they use.

### Summary

- There is no single setting for Java thread stack depth (number of frames). It is limited dynamically by system memory and stack size.
- Java thread stack size is the maximum memory one thread can use for its stack.
- The larger the stack size, the more frames fit, and the deeper the stack can go.
- The smaller each frame is (for example, a smaller local variable table), the more frames fit within a fixed stack size, and the deeper the stack can go.

## Experiment

|  |  |
| --- | --- |
| Host | 32C 128G |
| OS | Linux 4.19 |
| max_user_process | 506354 |
| max_threads | 1012708 |
| pid_max | 4194303 |
| max_map_count | 262144 |

java demo:

```java
private static Object s = new Object();
    private static int count = 0;

    @RequestMapping(value = "/threads", method = RequestMethod.GET)
    public String threads() {
        log.info("threads");
        for (; ; ) {
            new Thread(new Runnable() {
                public void run() {
                    synchronized (s) {
                        count += 1;
                        log.info("New thread #" + count);
                    }
                    for (; ; ) {
                        try {
                            Thread.sleep(1000);
                        } catch (Exception e) {
                            System.err.println(e);
                        }
                    }
                }
            }).start();
        }
    }
```

Running directly on the host: 130,702 threads created.

```
2022-03-20 14:19:25.642  INFO 3112536 --- [  Thread-130703] com.example.opsdemo.IndexController      : New thread #130702
Java HotSpot(TM) 64-Bit Server VM warning: INFO: os::commit_memory(0x00007efcebec6000, 12288, 0) failed; error='Cannot allocate memory' (errno=12)
#
# There is insufficient memory for the Java Runtime Environment to continue.
# Native memory allocation (mmap) failed to map 12288 bytes for committing reserved memory.
# An error report file with more information is saved as:
# /tmp/opsdemo/hs_err_pid3112536.log
2022-03-20 14:19:25.652 ERROR 3112536 --- [nio-8888-exec-1] o.a.c.c.C.[.[.[/].[dispatcherServlet]    : Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception [Handler dispatch failed; nested exception is java.lang.OutOfMemoryError: unable to create new native thread] with root cause

java.lang.OutOfMemoryError: unable to create new native thread
```

Running in a container deployed as a pod on the same host: 16,334 threads created.

```
2022-03-20 13:11:34.403  INFO 7 --- [   Thread-16335] com.example.opsdemo.IndexController      : New thread #16334
2022-03-20 13:11:34.419 ERROR 7 --- [nio-8888-exec-1] o.a.c.c.C.[.[.[/].[dispatcherServlet]    : Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception [Handler dispatch failed; nested exception is java.lang.OutOfMemoryError: unable to create new native thread] with root cause

java.lang.OutOfMemoryError: unable to create new native thread
  at java.lang.Thread.start0(Native Method) [na:1.8.0_242]
  at java.lang.Thread.start(Thread.java:744) [na:1.8.0_242]
```

### Experiment summary

- Directly on the host, we can create about 130k threads, limited by memory.
- In a pod, we can create about 16k threads, so something else is clearly limiting it, most likely the cgroup memory limit.

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/Llziahm6McDBc6BotvgUHQ)).*
