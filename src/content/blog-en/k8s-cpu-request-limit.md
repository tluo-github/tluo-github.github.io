---
title: "Kubernetes CPU Requests and Limits"
description: "What are a pod's CPU requests and limits, really? Starting from Linux CFS scheduling, this post traces how they end up in cgroups and explains why production should set them equal."
pubDate: 2022-03-22
tags: ["Kubernetes", "Linux"]
---

> What exactly are CPU requests and limits on a Kubernetes pod? Why can requests be set to a half or a third of limits in test environments, while production requires them to be exactly equal?

Requests and limits are Kubernetes' core mechanism for controlling cluster resources. If a pod declares resource requests, Kubernetes schedules it onto a node that can satisfy them.

Resources fall into two categories:

- CPU: a compressible resource
- Memory: an incompressible resource

Incompressible resources are easy to explain: cut a cake and give A a slice, and A has exactly that slice. This post focuses on how CPU is divided. As we know, what Kubernetes does best is define interfaces, while the actual implementation is provided by the layers and vendors underneath.

To put it simply, CPU request and limit are just values set by Kubernetes that are passed through Docker and end up in the cgroup files cpu.shares, cpu.cfs_period_us and cpu.cfs_quota_us.

To understand these three files, we need to start from CPU scheduling policies.

## CPU scheduling policies

In Linux, many tasks share the CPU, which inevitably means they compete for it. How do we hand out the CPU to ready tasks so that every task makes progress and CPU utilization stays as high as possible? That is the problem CPU scheduling solves.

Scheduling is the process of picking the next task to run from the ready queue.

![](/images/k8s-cpu-request-limit/1.png)

Common scheduling policies fall into two categories: RT (real-time) scheduling and CFS (Completely Fair Scheduler).

- RT scheduling
- CFS scheduling

RT (real-time) scheduling allocates the processor to complete real-time tasks, which require the computer to respond within a deadline the user can accept. RT scheduling comes in two flavors: FIFO and RR.

### FIFO

Also known as first come, first served.

All tasks are kept in a linked list and executed one after another.

The task that becomes runnable first gets the CPU first and keeps it until it yields.

| Pros | Simple |
| --- | --- |
| Cons | Short tasks may queue behind long ones, so average turnaround time varies a lot. |
| Turnaround time | Time from a task's start to its completion; turnaround time = waiting time + running time |

### Round robin

Round robin allocates CPU in time slices.

Once an RR task starts running, if it doesn't block, it runs until its time slice expires.

| Pros | Short average response time |
| --- | --- |
| Cons | Choosing the right time slice is hard. If it is too large, waiting times are long; if it is too small, the system is responsive but context-switch overhead is high. Rule of thumb: keep context-switch overhead within 1% of the time slice. |

### RT priorities

FIFO and RR are both RT (real-time) scheduling and are usually used together with priorities.

Tasks are scheduled by priority.

The highest-priority task gets the CPU first; lower-priority tasks only get a chance to run after higher-priority ones yield.

Rule 1: if priority(A) > priority(B), run A (not B).

Rule 2: if priority(A) = priority(B), run A and B in turn.

When tasks have the same priority:

With the FIFO scheduler, the task that becomes runnable first gets the CPU first and keeps it until it yields.

With the RR scheduler, tasks of the same priority share the processor in turns. Once an RR task starts running, if it doesn't block, it runs until its time slice expires.

### CFS: the Completely Fair Scheduler

A scheduling policy has to consider fairness, which is why the Completely Fair Scheduler (CFS) was introduced.

| Goal | Let all tasks use the CPU fairly |
| --- | --- |
| Strategy | 1. Track how much CPU time each task has used 2. At each scheduling point, pick the task that has used the least |
| Benefits | 1. Prevents an application from creating high-priority tasks that hog the CPU and starve everything else. 2. Developers don't need to tune thread priorities; the OS manages it. 3. The more threads applications create, the more this pays off. |

Unlike the RR scheduler, CFS has no concept of time slices; instead it allocates shares of CPU time. For example, if 2 tasks of the same priority run on one CPU, each gets 50% of the CPU time; with 4 tasks, each gets 25%. That is the fairness it aims for.

#### How CFS is implemented

CFS stores each task's CPU time in a red-black tree. The leftmost leaf has the smallest time and is the next task to be scheduled.

![](/images/k8s-cpu-request-limit/2.png)

What the red-black tree stores is virtual runtime.

#### Virtual runtime

CFS doesn't use priority directly; it uses it as a decay factor on how fast a task's allowed run time is consumed. Low-priority tasks have a higher decay factor and high-priority tasks a lower one, which means a low-priority task burns through its allowed time faster than a high-priority task.

![](/images/k8s-cpu-request-limit/3.png)

Virtual runtime = real runtime × 1024 / weight.

With a large weight, the virtual clock runs slower than the real clock and the task gets more run time; with a small weight, the virtual clock runs faster than the real clock.

**The formulas**

> Feel free to skip the details of these formulas.

![](/images/k8s-cpu-request-limit/4.png)

```
Formula 1:
process runtime = scheduling period * process weight / sum of all process weights
```

For example, with only two processes A and B, weighted 1 and 2, and a 30 ms scheduling period, A gets 30ms × (1/(1+2)) = 10 ms of CPU and B gets 30ms × (2/(1+2)) = 20 ms. So within those 30 ms, A runs for 10 ms and B for 20 ms.

```
Formula 2:
vruntime = process runtime * NICE_0_LOAD / process weight
```

NICE_0_LOAD is the weight of a process with nice 0, which means every process uses 1024, the weight of nice 0, as its baseline. In the A/B example above, B's weight is twice A's, so B's vruntime grows at half A's speed.

Substituting formula 1 for the actual runtime in formula 2 gives:

```
vruntime = (scheduling period * process weight / total weight of all processes) * NICE_0_LOAD / process weight
vruntime = scheduling period * NICE_0_LOAD / total weight of all processes
```

Weights are determined by nice values. There is a one-to-one mapping between a process's nice value and its weight, converted through the global array prio_to_weight: the higher the nice value, the lower the weight.

```
There are 40 nice values in total; each step changes the weight by roughly 10%.
static const int prio_to_weight[40] = {
    /* -20 */ 88761, 71755, 56483, 46273, 36291,
    /* -15 */ 29154, 23254, 18705, 14949, 11916,
    /* -10 */ 9548, 7620, 6100, 4904, 3906,
    /* -5 */ 3121, 2501, 1991, 1586, 1277,
    /* 0 */ 1024, 820, 655, 526, 423,
    /* 5 */ 335, 272, 215, 172, 137,
    /* 10 */ 110, 87, 70, 56, 45,
    /* 15 */ 36, 29, 23, 18, 15,
};
```

**CFS flow**

![](/images/k8s-cpu-request-limit/5.png)

- Convert each task's runtime into virtual runtime (vruntime) based on its weight;
- Insert it into the CFS red-black tree by vruntime, with smaller vruntime to the left;
- At the next scheduling point, pick the entity with the smallest vruntime to run.

**CPU CFS summary**

- CFS = round robin plus weighted vruntime.
- Each task's vruntime grows at a rate computed from its weight, so high-priority tasks get more CPU.
- The task with the smallest vruntime is scheduled first. In other words, CFS tries to keep every task's vruntime equal: high-weight tasks accumulate vruntime slowly and are scheduled first, while low-weight tasks accumulate it quickly and are more likely to be skipped.

## How Kubernetes CPU requests and limits are mapped

At the start we said a pod's CPU requests and limits map to cpu.shares. Let's trace the source code to confirm.

kubernetes: v1.20.4

pkg/kubelet/kuberuntime/kuberuntime_container_linux#42

```go
func (m *kubeGenericRuntimeManager) generateLinuxContainerConfig(container *v1.Container, pod *v1.Pod, uid *int64, username string) *runtimeapi.LinuxContainerConfig {
    lc := &runtimeapi.LinuxContainerConfig{
        Resources: &runtimeapi.LinuxContainerResources{},
        SecurityContext: m.determineEffectiveSecurityContext(pod, container, uid, username),
    }

    // set linux container resources
    var cpuShares int64
    cpuRequest := container.Resources.Requests.Cpu()
    cpuLimit := container.Resources.Limits.Cpu()
    memoryLimit := container.Resources.Limits.Memory().Value()
    oomScoreAdj := int64(qos.GetContainerOOMScoreAdjust(pod, container,
        int64(m.machineInfo.MemoryCapacity)))
    // If request is not specified, but limit is, we want request to default to limit.
    // API server does this for new containers, but we repeat this logic in Kubelet
    // for containers running on existing Kubernetes clusters.
    if cpuRequest.IsZero() && !cpuLimit.IsZero() {
        cpuShares = milliCPUToShares(cpuLimit.MilliValue())
    } else {
        // if cpuRequest.Amount is nil, then milliCPUToShares will return the minimal number
        // of CPU shares.
        cpuShares = milliCPUToShares(cpuRequest.MilliValue())
    }
    lc.Resources.CpuShares = cpuShares
    
    ...
    return lc
}
```

milliCPUToShares:

```
if milliCPU == 0 {
        // Return 2 here to really match kernel default for zero milliCPU.
        return minShares
    }
    // Conceptually (milliCPU / milliCPUToCPU) * sharesPerCPU, but factored to improve rounding.
    shares := (milliCPU * sharesPerCPU) / milliCPUToCPU
    if shares < minShares {
        return minShares
    }
    return shares
```

The relationship in the code above, as a table:

| Docker parameter | How it is computed |
| --- | --- |
| cpuShares | If requests.cpu is 0 and limits.cpu is not, limits.cpu is the input; otherwise requests.cpu is. If the input is 0, it is set to minShares == 2; otherwise it is requests.cpu × 1024 / 100 |
| cpuQuota, cpuPeriod | Derived from limits.cpu. cpuPeriod defaults to 100 ms and cpuQuota is the number of cores in limits.cpu × 100 ms. This is a hard limit |

**Summary**

- k8s request.cpu = docker cpu.shares
- k8s limit.cpu = docker cpu.quota

## Linux control group

Linux control groups (cgroups) were proposed by Google engineers and merged into kernel 2.6.24 in January 2008. They cover many topics and subsystems; here we only discuss the cpu subsystem.

### cpu.shares

This file's value is the weight, which feeds into the rate at which CFS vruntime is consumed.

### cpu.cfs_period_us , cpu.cfs_quota_us

- cfs_period_us is the scheduling period, in microseconds (us)
- cpu.cfs_quota_us is the absolute CPU time allowed within that period, in microseconds (us)

Together, the two files set a cap on CPU usage. cfs_period_us ranges from 1 ms to 1 s, and cfs_quota_us just needs to be greater than 1 ms. A cfs_quota_us of -1 (the default) means no limit on CPU time. Some examples:

```cpp
1. Limit to 1 CPU (250 ms of CPU time every 250 ms)
    # echo 250000 > cpu.cfs_quota_us /* quota = 250ms */
    # echo 250000 > cpu.cfs_period_us /* period = 250ms */

2. Limit to 2 CPUs (cores) (1000 ms of CPU time every 500 ms, i.e. two cores)
    # echo 1000000 > cpu.cfs_quota_us /* quota = 1000ms */
    # echo 500000 > cpu.cfs_period_us /* period = 500ms */

3. Limit to 20% of 1 CPU (10 ms of CPU time every 50 ms, i.e. 20% of one core)
    # echo 10000 > cpu.cfs_quota_us /* quota = 10ms */
    # echo 50000 > cpu.cfs_period_us /* period = 50ms */
```

From CFS we can see that a process's chance of being scheduled depends on how fast its vruntime is consumed, which is its weight, and in cgroups the weight is cpu.shares. In other words, cpu.shares determines a process's "chance" of getting the CPU.

- The weight in cpu.shares affects how fast CFS vruntime is consumed.
- cpu.cfs_period_us is the scheduling period once the process gets its chance.
- cpu.cfs_quota_us is the absolute CPU time within that period.
- cpu.shares implements the Kubernetes CPU request.
- cpu.cfs_period_us and cpu.cfs_quota_us together implement the Kubernetes CPU limit.

## Conclusion

Q: What exactly are CPU requests and limits on a Kubernetes pod?

A: A request is essentially the pod's weight when competing for CPU; a limit essentially caps how much CPU time the pod can use per unit of time.

Q: Why can CPU requests be set to a half or even a third of limits in test environments?

A: Because the scheduler treats requests as a node's CPU budget, and it only trusts this static ledger: once a node with 100 cores is fully allocated, no new pods can land on it. In reality most apps never use 100% of their CPU, so looking across the cluster, CPU utilization per node is very low. That creates a contradiction: the cluster admin sees low CPU usage everywhere, which is wasteful, while Kubernetes says allocation is already full. In less important test environments, you can set requests to half of limits and fit twice as many pods. (At the extreme, request 0.1C and limit 4C, which I don't recommend.)

Q: Why must CPU requests equal limits in production?

A: Because when the kubelet creates a pod, it assigns one of three QoS classes. request == limit gives the highest QoS class; making them different drops it one level; setting neither gives the lowest.

Q: If setting the CPU request below the limit lets us deploy more pods, is that overcommitting?

A: No! Real overcommitting raises the cap on the allocation ratio (above 100%), while lowering requests only raises the allocation ratio itself. And lowering requests has drawbacks!

For example: request=0.1c limit=4c

Drawbacks:

- CPU weighting stops working: when resources are tight, pods with low requests can grab compute from pods with high requests.
- Scheduler policies stop working: several CPU-heavy pods may land on the same node and overload it.
- Core-count detection breaks: for example, the JVM concludes it can only use 1 CPU, which hurts stability.
- The pod's QoS class is downgraded: its process group gets suppressed by the Burstable cpu.shares value.
- Requests have to be lowered app by app, the right ratio is very hard to estimate, and it can't be changed after scheduling.

The details of the CFS algorithm and cgroups are complex, so please forgive any mistakes; the core ideas should hold.

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/1rtxBv87CAUvNMzcJtYlkg)).*
