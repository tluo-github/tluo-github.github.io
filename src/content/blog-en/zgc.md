---
title: "ZGC: Sub-millisecond GC Pauses"
description: "A walkthrough of how ZGC achieves sub-millisecond pauses on OpenJDK 17: from the pause bottlenecks of CMS and G1 to memory layout, colored pointers, multi-mapping, load barriers and concurrent mark/relocate, ending with logs and tuning."
pubDate: 2023-02-21
tags: ["Java", "JVM", "GC"]
---

> This post is based on OpenJDK 17.

## 1. ZGC overview

The Z Garbage Collector (ZGC) is a scalable low-latency garbage collector introduced in JDK 11 and declared production-ready in JDK 15. It aims to meet the following goals:

- **< 1 ms** maximum pause time (10 ms before JDK 16, < 1 ms from JDK 16)
- STW pauses that don't grow with the size of the heap or the live set
- Heaps from 8 MB to 16 **TB**

From these goals we can see that ZGC is designed for memory management in large-heap, low-latency services. At its core ZGC is a concurrent collector, which means all the heavy lifting happens while Java threads keep running. That greatly reduces the impact of GC on application response times.

ZGC features: **concurrent, region-based, compacting, NUMA-aware, colored pointers, load barriers**, and more.

## 2. Traditional garbage collection

When we write Java programs we don't need to free memory explicitly; Java's garbage collector reclaims it for us. The GC tracks object references and frees objects that are no longer reachable. To do that it has to monitor the state of objects on the heap: once an object is unreachable, the GC can consider reclaiming it.

![](/images/zgc/1.png)

The availability of many low-latency, high-availability Java services suffers from GC pauses. A GC pause means STW (stop the world) during collection: all application threads stop and wait for the pause to end. Take one of our microservices: some upstream callers required responses within 65 ms with 99.99% availability, but GC pauses kept us from meeting that target. We were using CMS at the time, with each young GC taking 40 ms, 10 times a minute, and an average API response time of 30 ms. A quick calculation shows that (40ms + 30ms) × 10 / 60000ms = 1.12% of requests saw their response time grow by 0–40 ms, and 30ms × 10 / 60000ms = 0.5% of requests saw it grow by a full 40 ms. Clearly GC pauses had a big impact on response time. To reduce it, we tuned for shorter individual pauses and for fewer collections, and we also tried G1, but none of these three measures reduced the impact of GC on availability.

## 3. The pause-time bottleneck in CMS and G1

CMS young GC, G1 and ZGC are all based on mark-copy, but differences in how they implement it lead to huge differences in performance.

Mark-copy is used by CMS's young generation (ParNew is CMS's default young collector) and by G1. It has three phases:

- Marking: starting from the GC roots, mark live objects;
- Relocation: copy live objects to new memory addresses;
- Remapping: since relocation changed object addresses, all pointers to an object's old address must be updated to its new address.

Let's take G1 as an example and walk through its mark-copy process (used by both young and mixed GCs in G1) to find the main bottleneck behind G1's pauses. The G1 collection cycle looks like this:

![](/images/zgc/2.png)

| STW phase | Description |
| --- | --- |
| Pauses in marking | - Initial mark (STW): marks all objects directly reachable from the GC roots. Because there aren't many GC roots, this is usually very short. - Concurrent mark (concurrent): starting from the GC roots, analyzes reachability across the heap to find live objects. It runs concurrently, so application and GC threads are active at the same time. It takes much longer, but since it isn't STW we don't care much about its duration. - Remark (STW): re-marks objects that changed during concurrent marking. |
| Pauses in cleanup | - Cleanup (STW): counts which regions contain live objects and which don't. It neither frees garbage nor copies live objects. |
| Pauses in copying | - The evacuation phase of the copying algorithm (STW) allocates new memory and copies objects' fields. Allocation is usually very fast, but copying fields can take a long time, because copying cost grows with the number and complexity of live objects. The more complex the objects, the longer the copy. |

Of the four STW phases, initial mark is short because it only marks the GC roots; remark is short because few objects are involved; cleanup is short because there are few regions. Evacuation must process every live object, so it takes long. The bottleneck of G1's pause time is therefore the STW evacuation phase of mark-copy. **Why can't evacuation run concurrently, like marking?** **Mainly because G1 never solved the problem of reliably locating an object's address while it is being moved.**

**ZGC makes exactly this phase concurrent, using colored pointers plus load barriers to locate objects precisely while they are being moved.**

## 4. How ZGC works

Like ParNew in CMS and G1, ZGC uses mark-copy, but it improves on it significantly: in ZGC, marking, relocation and remapping are almost entirely concurrent. That is the key reason ZGC can keep pauses under 1 ms.

The ZGC collection cycle looks like this:

![](/images/zgc/3.png)

| STW phase | Description |
| --- | --- |
| Pause mark start | Only scans the GC roots; its duration is proportional to the number of GC roots. |
| Pause mark end | Very short, at most 1 ms; if it would take longer, ZGC goes back to concurrent marking. |
| Pause relocate start | Only scans the GC roots; its duration is proportional to the number of GC roots. |

Almost all of ZGC's pauses depend only on the size of the GC root set, so pause times don't grow with the heap or the live set. In contrast, G1's evacuation phase is fully STW, and its pause time grows with the amount of live data.

## 5. Key techniques in ZGC

### 5.1 Memory layout

ZGC is a region-based, (for now) non-generational garbage collector that uses load barriers, colored pointers and multi-mapped memory to implement a concurrent mark-compact algorithm, with low latency as its top priority.

Let's start with ZGC's memory layout. Like Shenandoah and G1, ZGC uses a region-based heap layout, but unlike them, ZGC's regions are dynamic: they are created and destroyed dynamically, and their sizes vary. On x64, ZGC regions come in three sizes (see the figure below):

- Small regions: fixed at 2 MB, for objects smaller than 256 KB.
- Medium regions: fixed at 32 MB, for objects from 256 KB up to 4 MB.
- Large regions: variable size, always a multiple of 2 MB, for objects of 4 MB or more.

![](/images/zgc/4.png)

### 5.2 NUMA support

NUMA's counterpart is UMA, **Uniform Memory Access**; NUMA stands for Non-Uniform Memory Access. With UMA there is a single block of memory that all CPUs access, so they compete for the memory bus. Competition means locking, locking hurts efficiency, and the more CPU cores there are, the fiercer the competition. With NUMA, each CPU has its own block of memory placed closest to it on the motherboard, and each CPU accesses its own block first, which naturally improves efficiency.

NUMA architectures are very common in mid-size and large servers as a high-performance solution, and they are especially good for latency. ZGC detects NUMA automatically and takes full advantage of it. G1 added support in later versions as well.

### 5.3 Colored pointers

> Colored pointers are a technique for storing information inside pointers.

ZGC only supports 64-bit systems. It divides the 64-bit virtual address space into several subspaces, as shown below:

![](/images/zgc/5.png)

![](/images/zgc/6.png)

Every object has a 64-bit pointer, split as follows:

- 16 bits: reserved for future use;
- 1 bit: Finalizable flag;
- 1 bit: Remapped flag;
- 1 bit: Marked1 flag;
- 1 bit: Marked0 flag;
- 44 bits: the object's address (so it can address 2^44 = 16 TB of memory).

### 5.4 Multi-mapped addresses

#### 5.4.1 First explanation

The mapping from virtual to physical memory can be implemented in hardware, in the operating system or in software. On Linux, ZGC uses multi-mapping to map several different virtual addresses to the same physical address. It is a many-to-one mapping, which means the address space ZGC sees in virtual memory is larger than the actual heap. If you treat the flag bits in a colored pointer as an address segment selector, then as long as all those segments map to the same physical memory, colored pointers can be used directly for addressing after the multi-mapping translation, as shown below:

![](/images/zgc/7.png)

Multi-mapping can bring some extra benefits, such as making it easier to copy large objects, but fundamentally it is just a by-product of colored pointers, not something designed for another feature.

Here, [0, 8 TB) is the Java heap, [8 TB, 12 TB) is the M0 address space, [12 TB, 16 TB) is the M1 address space, [16 TB, 18 TB) is reserved and unused, and [18 TB, 24 TB) is the Remapped space.

When the application creates an object, it first gets a virtual address in the heap space, but that address isn't mapped to real physical memory. ZGC also reserves a virtual address for the object in each of the M0, M1 and Remapped spaces. These three addresses map to the same physical address, and at any given time only one of the three spaces is active. ZGC sets up three virtual address spaces to trade space for time and reduce GC pauses, where the "space" is virtual space, not real physical memory. Later sections explain how ZGC switches between them.

#### 5.4.2 Second explanation

Borrowing from virtual and physical addresses in operating systems, ZGC designs a multi-mapping between memory and addresses.

Let's start with an analogy:

To your parents you are their son; to your girlfriend you are her boyfriend; to the whole world you are the most handsome person alive. You also have a name, but a name is just a label for you, not you yourself.

Drawn as a mapping:

![](/images/zgc/8.png)

If your name is unique in the world, then "your name", "your father's son", "your girlfriend's boyfriend" and "the most handsome person in the world" all point to the same person: you.

Now let's look at ZGC's memory mapping.

To manage memory efficiently and flexibly, ZGC implements two levels of memory management, virtual memory and physical memory, along with a mapping between them.

When the application creates an object, it first gets a virtual address in the heap space, and ZGC also reserves a virtual address for the object in each of the three views, Marked0, Marked1 and Remapped. These three virtual addresses all map to the same physical address.

![](/images/zgc/9.png)

What do the Marked0, Marked1 and Remapped views in the figure mean?

They are ZGC's three views of the address space, and at any point in time exactly one of them is active.

In the analogy above, the three views correspond to "in your father's eyes", "in your girlfriend's eyes" and "in the world's eyes".

The addresses inside the three views are all virtual addresses, corresponding to "your father's son", "your girlfriend's boyfriend" and so on.

Finally, all these virtual addresses map to the same physical address, which corresponds to "you" in the analogy.

The same relationship expressed in a bit of Java:

![](/images/zgc/10.png)

Why design it this way? This is the clever part of ZGC: it trades virtual space for time. Switches between the three spaces are triggered by the different phases of garbage collection, and by guaranteeing that only one space is active at a time, ZGC makes the GC process efficiently concurrent. The details are described in the section on ZGC's concurrent algorithm below.

### 5.5 Load barriers

"A load barrier is a small piece of code the JVM inserts into application code. It runs when an application thread loads an object reference from the heap. Note that only loading an object reference from the heap triggers it."

Load barrier examples:

```js
Object o = obj.FieldA   // loads a reference from the heap: needs a barrier
<Load barrier>
Object p = o  // no barrier needed: not loading a reference from the heap
o.dosomething() // no barrier needed: not loading a reference from the heap
int i =  obj.FieldB  // no barrier needed: not an object reference
```

```

```

CMS and G1 both use write barriers, while ZGC uses load barriers. A write barrier is AOP around assigning an object reference; a load barrier is AOP around reading one.

What the load barrier does in ZGC:

GC threads and application threads run concurrently, so an application thread might follow a reference inside object A to object B while B is being moved or otherwise processed by a GC thread. With a load barrier, the application thread checks whether B is being handled by the GC, waits for that to finish, and then reads the object, guaranteeing correct data.

The detailed check-and-act steps are:

![](/images/zgc/11.png)

A second example:

```nginx
Ojbect a = obj.foo
```

Not only does `a` get the latest address, `obj.foo` is updated too, so the next access is normal and costs nothing extra.

The figure below shows the effect of the load barrier. In essence, during relocation ZGC records the mapping somewhere (the forwardingTable), and on reads the barrier triggers the reference fix-up.

![](/images/zgc/12.png)

This is also called "self-healing": not only is the assigned reference up to date, the source reference is fixed too.

Load barriers lower ZGC's throughput. Official measurements put the extra overhead at about 4%:

**Colored pointers and load barriers are what make concurrent relocation possible in ZGC.**

### 5.6 ZGC's concurrent algorithm

ZGC's concurrent algorithm switches between global address-space views and per-object address views, and combines this with SATB (snapshot-at-the-beginning) to achieve efficient concurrency.



Everything above was groundwork for explaining ZGC's concurrent algorithm. Many blog posts say colored pointers and load barriers are the core of ZGC, but they don't explain how the algorithm uses them. In my view the concurrent algorithm is the real core of ZGC; colored pointers and load barriers just serve it.

The global view switches across the three phases of the concurrent algorithm are:

- Initialization: after ZGC initializes, the address view of the whole memory space is set to Remapped.
- Concurrent marking: on entering marking, the view switches to Marked0 (M0 below) or Marked1 (M1 below). The first time it enters marking the view is M0, and any object accessed by a GC marking thread or an application thread has its address view changed from Remapped to M0. So when marking ends, each object's address is either in the M0 view or the Remapped view. M0 means the object is live; Remapped means it is not.
- Concurrent relocation: after marking comes relocation, and the address view is set back to Remapped. Any object accessed by a GC relocation thread or an application thread has its address view changed from M0 to Remapped.

![](/images/zgc/13.png)

#### Marking phase

During marking the global view switches to M0. Because the application and the marking threads run concurrently, objects may be accessed by either marking threads or application threads.

![](/images/zgc/14.png)

When marking ends, each object's address view is either M0 or Remapped:

- If it is M0, the object is live;
- If it is Remapped, the object is not live, and its memory can be reclaimed.

When marking ends, ZGC stores the addresses of all live objects in a liveness table; all live objects have the M0 view.

![](/images/zgc/15.png)

#### Relocation phase

During relocation the view switches to Remapped. The application and the relocation threads also run concurrently, so objects may be accessed by either relocation threads or application threads.

![](/images/zgc/16.png)

How an object's view changes across initialization, marking and relocation:

![](/images/zgc/17.png)

At this point, concurrent marking and concurrent relocation for one ZGC cycle are complete.

#### Why both M0 and M1?

Marking has two address views, M0 and M1, while the process above only used one. There are two so that ZGC can tell the previous marking apart from the current one: the second time it enters concurrent marking, the address view switches to M1 instead of M0.

ZGC collects memory page by page. When a page needs to be reclaimed, the objects in it must be relocated; if a page doesn't need relocation, neither do its objects.

![](/images/zgc/18.png)

As shown in the figure, at the start of the second GC cycle this object's address view is still M0. If the second cycle's marking also switched to M0, ZGC couldn't tell whether the object is live or was merely marked in the previous cycle. Switching the second cycle's marking to M1 makes the distinction possible. The three views then mean:

- M1: live objects identified in this cycle.
- M0: objects marked live in the previous cycle's marking and not relocated in its relocation phase, but identified as not live in this cycle.
- Remapped: objects relocated in the previous cycle's relocation phase or accessed by application threads, but identified as not live in this cycle.

What do address views and colored pointers buy us?

1. They speed up marking and relocation. Earlier collectors recorded GC information by changing mark bits in the object header, which requires memory access. With address views and colored pointers, ZGC doesn't need to touch the object at all; it just sets the corresponding bits in the address. That is why ZGC's marking and relocation are faster.
2. Because GC information lives in the reference pointer rather than the object header, once an object is known to be dead its memory can be reused immediately, which isn't possible when GC information is stored in the object header.

Colored pointers and load barriers are used not only in concurrent relocation but also in concurrent marking. To mark an object, a traditional collector needs a memory access to store liveness information in the object header; in ZGC it only needs to set bits 42–45 of the pointer, and since that is a register operation it is faster than accessing memory.

### 5.7 The ZGC collection process in detail

A ZGC collection has three major phases that break down into 10 steps.

| Step | Work | STW |
| --- | --- | --- |
| 1. Initial mark | Marks only objects directly reachable from the GC roots and pushes them onto the mark stack | Yes |
| 2. Concurrent mark | Traverses the object graph concurrently starting from the initially marked objects, and counts live objects per region. There is only one mark stack but many marking threads; to reduce contention, each thread gets its own stripe to work on. Think of the mark stack as split into several pieces, each traversed by one thread, much like the segments in Java 1.7's HashMap. Some threads inevitably finish faster than others, so **threads that become idle first steal tasks from others**, which balances the load. Sound familiar? Yes, it is the work-stealing mechanism of ForkJoinPool! |  |
| 3. Remark | Application threads keep running during the concurrent phase and may change references, causing some objects to be missed. A remark phase is needed to mark them. If this phase takes too long, ZGC goes back to concurrent marking: its goal is low latency, so any sign of a long pause must be nipped in the bud. | Yes |
| 4. Concurrent marking of non-strong roots and reference processing | Traverses the non-strong roots from the previous step and processes soft, weak and phantom references. This phase is concurrent. |  |
| 5. Reset relocation set | The forwardingTable is a map whose key is an object's address before relocation and whose value is its address afterwards. It was already used during marking, meaning remapping finished as part of marking, so it is no longer needed now. The next GC cycle still needs it, though, so this step resets the address maps of the relocated regions. |  |
| 6. Reclaim invalid regions | Reclaims virtual memory pages whose physical memory has already been released. When memory is tight, physical memory is released; but even if the virtual space were released at the same time, the regions themselves couldn't be, because regions can only be released after the next round of marking. So invalid virtual pages exist and are reclaimed in this step. |  |
| 7. Select regions to reclaim | As in G1, there are many reclaimable regions, so ZGC picks the ones with the most garbage as this cycle's relocation set. |  |
| 8. Initialize forwarding tables for the relocation set | Initializes the forwardingTable of each region to be reclaimed. |  |
| 9. Initial relocation | Starting from the root set, if an object is in the relocation set, space is allocated for it in a new region; if not, the object is marked Remapped. Note this step is STW and only relocates objects directly reachable from the roots. | Yes |
| 10. Concurrent relocation | Starting from the objects relocated in the previous step, traverses and relocates concurrently. This step is crucial: G1 needs STW to relocate objects but ZGC doesn't, so latency is much lower. |  |

### 5.8 What triggers a ZGC cycle

ZGC's triggering mechanism is quite different from CMS's and G1's. ZGC is fundamentally concurrent, and new objects keep being allocated throughout a GC. Making sure newly allocated objects don't fill up the heap before the GC finishes is the number one goal of ZGC tuning, because in ZGC, when garbage can't be collected fast enough and the heap fills up, running threads stall, sometimes for seconds.

ZGC has several triggers:

- Allocation stall: when garbage can't be collected in time and fills the heap, some threads block. We should avoid this. Log keyword: "Allocation Stall".
- Adaptive, allocation-rate based: the main trigger. Put simply, ZGC uses the recent allocation rate and GC duration to compute the memory usage threshold at which the next GC should start. For the theory behind the adaptive algorithm, see Peng Chenghan's book on the design and implementation of ZGC. The threshold is controlled by ZAllocationSpikeTolerance, which defaults to 2; the larger it is, the earlier GC triggers. Tuning this parameter solved several problems for us. Log keyword: "Allocation Rate".
- Fixed interval: controlled by ZCollectionInterval, useful for traffic spikes. When traffic changes smoothly, the adaptive algorithm may only trigger GC once heap usage passes 95%; when traffic spikes, it may trigger too late and cause some threads to block. We used this parameter to handle traffic spikes, such as scheduled promotions and flash sales. Log keyword: "Timer".
- Proactive: similar to the fixed interval, but the interval isn't fixed; ZGC computes the timing itself. Since our services already used the fixed-interval trigger, we turned this off with -ZProactive to avoid overly frequent GCs hurting availability. Log keyword: "Proactive".
- Warm-up: happens right after the service starts and usually needs no attention. Log keyword: "Warmup".
- External: triggered by an explicit System.gc() call in code. Log keyword: "System.gc()".
- Metadata allocation: triggered when the metaspace runs short; usually needs no attention. Log keyword: "Metadata GC Threshold".

### 5.9 ZGC logs

The points to watch in a complete GC are marked in the figure.

![](/images/zgc/19.png)

Each line of the GC log describes part of the GC process. The key information:

- **Start**: GC starts, along with the reason it was triggered. In the figure above it was triggered by the adaptive algorithm.
- **Phase-Pause Mark Start**: initial mark, STW.
- **Phase-Pause Mark End**: remark, STW.
- **Phase-Pause Relocate Start**: initial relocation, STW.
- **Heap**: records heap size changes before and after Mark and Relocate during the GC. High and Low record the maximum and minimum values. We usually watch Used under High: if it reaches 100%, memory allocation definitely ran short during the GC, and the GC needs to start earlier or run faster.
- **GC statistics**: collection statistics can be printed periodically, covering the last 10 seconds, 10 minutes, 10 hours and everything since startup. They help track down anomalies.

The log is long; the key points are underlined in red and fairly self-explanatory. For more detail, there is plenty of material online.

![](/images/zgc/20.png)

### 5.10 What causes ZGC pauses

In practice we found six situations that pause the application:

- **During GC, initial mark**: Pause Mark Start in the log.
- **During GC, remark**: Pause Mark End in the log.
- **During GC, initial relocation**: Pause Relocate Start in the log.
- **Allocation stall**: when memory runs out, threads block until GC finishes. Keyword: "Allocation Stall".
- **Safepoints**: GC can only happen once all threads reach a safepoint, and ZGC enters safepoints periodically to decide whether a GC is needed. Threads that reach the safepoint first must wait for the rest until all threads are suspended.
- **Thread or heap dumps**: for example jstack or jmap.

### 5.11 ZGC options

| General GC options | ZGC options | ZGC diagnostic options (-XX:+UnlockDiagnosticVMOptions) |
| --- | --- | --- |
| -XX:MinHeapSize, -Xms    -XX:InitialHeapSize, -Xms    -XX:MaxHeapSize, -Xmx    -XX:SoftMaxHeapSize    -XX:ConcGCThreads    -XX:ParallelGCThreads    -XX:UseDynamicNumberOfGCThreads    -XX:UseLargePages    -XX:UseTransparentHugePages    -XX:UseNUMA    -XX:SoftRefLRUPolicyMSPerMB    -XX:AllocateHeapAt | -XX:ZAllocationSpikeTolerance    -XX:ZCollectionInterval    -XX:ZFragmentationLimit    -XX:ZMarkStackSpaceLimit    -XX:ZProactive    -XX:ZUncommit    -XX:ZUncommitDelay    -Xlog    -XX:+AlwaysPreTouch | -XX:ZStatisticsInterval    -XX:ZVerifyForwarding    -XX:ZVerifyMarking    -XX:ZVerifyObjects    -XX:ZVerifyRoots    -XX:ZVerifyViews |

**ConcGCThreads**

ZGC is a concurrent collector, so the number of concurrent GC threads matters a lot. The more concurrent GC threads you configure, the fewer threads are left for the application, which is clearly bad for stability. ZGC sets this automatically, so unless you are very sure, it's best not to set it.

**ParallelGCThreads**

The number of threads used in STW phases, 60% of total cores by default. These are parallel threads, unlike ConcGCThreads above: ConcGCThreads is the number of GC threads running concurrently with application threads, while ParallelGCThreads is the number of GC threads working in parallel during STW phases (such as root scanning in the first phase), when only GC threads run.

**UseDynamicNumberOfGCThreads**

Starting with JDK 17, ZGC supports -XX:+UseDynamicNumberOfGCThreads and tries to use as few threads as possible while keeping up with the allocation rate. This avoids using more CPU time than necessary, leaving more for Java threads. Note that with this enabled, -XX:ConcGCThreads changes meaning from "use this many threads" to "use at most this many threads". Unless you have an unusual workload, you normally don't need to touch -XX:ConcGCThreads; ZGC's heuristics pick a suitable maximum based on the size of the system.

**UseNUMA**

ZGC enables NUMA support by default, but if the JVM detects that it is bound to a subset of CPUs, it disables NUMA automatically. You can enable it explicitly with -XX:+UseNUMA or disable it with -XX:-UseNUMA. On a NUMA server, setting -XX:+UseNUMA gives a clear performance boost.

**UseLargePages**

Configuring ZGC to use large pages usually improves throughput, latency and startup time, with no real downside other than a more complicated setup. It requires root privileges, which is why large pages aren't enabled by default.

**ZAllocationSpikeTolerance**

The correction factor for ZGC's adaptive trigger, default 2; the larger it is, the earlier ZGC triggers.

**ZCollectionInterval**

The minimum interval between ZGC cycles, in seconds.

**ZProactive**

**-XX:+UnlockDiagnosticVMOptions -XX:-ZProactive**: whether proactive collection is enabled. It is on by default; this setting turns it off.

**ZUncommit**

Before getting to this option, let's look at how the JVM requests and returns memory. Earlier collectors such as ParallelOldGC and CMS never returned memory to the OS once the JVM had requested it, even after a GC freed lots of space. As a result, the RSS you see in top only keeps growing and usually ends up above Xmx.

ZGC, by default, does return unused memory to the OS, which is very useful for applications and servers that care about memory footprint. This can be turned off with **-XX:-ZUncommit**. However it returns memory, the JVM always keeps at least the size given by Xms, which means this option has no effect when Xmx equals Xms.

It works together with another option, -XX:ZUncommitDelay=sec, which defaults to 300 seconds. It sets the maximum delay before unused memory is returned to the OS. Unused memory shouldn't be returned immediately, as that would cause frequent returning and re-requesting, so this option controls how long memory must stay unused before it is returned.

**AlwaysPreTouch**

With -XX:+AlwaysPreTouch, you tell the GC to touch the heap at startup (up to -Xms or -XX:InitialHeapSize). This ensures the memory pages backing the heap are 1) actually allocated and 2) faulted in. Doing it at startup avoids paying that cost later, when the application is running and starts touching memory. Pre-touching the heap can be a sensible choice for some applications, but as always it is a trade-off, since startup takes longer.

Before JDK 14, ZGC used a single thread to pre-touch the heap, which could take a long time for large heaps. Now ZGC uses multiple threads, greatly reducing startup/pre-touch time. On large machines with terabytes of memory, this can mean startup times in seconds instead of minutes.

**Xlog**

**-Xlog**: sets the content, format, location and size of GC logs.

Since JDK 9, -Xloggc is no longer used; use -Xlog instead.

> -Xlog:safepoint,classhisto*=trace,age*,gc*=info:file=/opt/logs/logs/gc-%t.log:time,tid,tags:filecount=5,filesize=50m

## 6. Where ZGC is heading

ZGC was born in JDK 11 and, after steady refinement, was no longer experimental in JDK 15. In JDK 16, concurrent thread stack scanning cut STW time by another order of magnitude, into the sub-millisecond era. JDK 17 brought no ZGC changes in its release notes, which suggests it has stabilized.

From Linux/x64 only to many platforms, from no compressed pointers to compressed class pointers… ZGC has been evolving very quickly.

![](/images/zgc/21.png)

ZGC is an excellent garbage collector. It draws on Pauseless GC and seems to be heading in the direction of C4 by introducing generations.

ZGC pursues low pause times to the extreme. It gives up some throughput to get there, but that is a perfectly acceptable trade-off. Its colored pointers and multi-mapping ideas are well worth learning from.

References:

- Exploring and practicing the next-generation garbage collector ZGC (in Chinese)
- How does ZGC work, and why can it achieve low latency? - Zhihu (in Chinese)
- Java's cutting edge: ZGC (in Chinese)
- A first look at ZGC in JDK 14 | HeapDump community (in Chinese)
- An in-depth analysis of ZGC | HeapDump community (in Chinese)
- Main - Main - OpenJDK Wiki

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/6gxVouzg61cWl1m5FWssAg)).*
