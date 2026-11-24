---
title: "K8S cpu request 和 limit"
description: "Pod 的 CPU request 和 limit 到底是什么？从 Linux CFS 调度讲起，追踪它们如何落到 cgroup，并解释生产环境为什么要设成相等。"
pubDate: 2022-03-22
tags: ["Kubernetes", "Linux"]
---

> k8s pod cpu requests 和 limits 到底是什么,为什么测试环境requests 可以设置成 limits 的二分之一或三分一,生产环境为什么又要设置成完成相等

资源需求(requests) 和限制(limits) 是 K8S 用于控制集群资源的核心机制，如果一个 pod 设置了资源需求(requests),K8S将安排调度它到能提供满足它资源需求的 Node 上。

资源的分两大类型:

- CPU 可压缩资源
- Memory 不可压缩资源

不可压缩资源比较好解释,一块蛋糕划分多少给A,A 就有多少，本篇文章就专注 CPU 资源的划分,我们知道 K8S 最擅长干的活是定义接口，具体实现由底层后其他产商提供。

这里可以简单的认为 cpu request&& limit 仅仅是 k8s 设置的一个值经过docker 最终传递到 cgroup cpu.shares、cpu.cfs_period_us、cpu.cfs_quota_us。

而要弄清楚这三个文件我们要从 CPU 调度策略开始起航

## CPU 调度策略

在Linux 操作系统中,多个任务共享CPU 资源，这必然导致多个任务对CPU的竞争.那么如何把CPU 分给处于就绪状态的任务,保证各个任务顺利运行又能使得这种分配下CPU 利用率最高,这就是CPU 调度要解决的问题。

调度就是CPU 从ready 就绪 队列中挑选下一个要运行任务的过程。

![](/images/k8s-cpu-request-limit/1.png)

常见的调度策略分2两大类: RT 实时调度、CFS 完全公平调度

- RT 调度
- CFS 调度

RT （real time) 实时调度是为了完成实时处理任务而分配计算机处理器的调度方法。实时处理任务要求计算机在用户允许的时限范围内给出计算机响应信号。RT （real time) 调度 又分为FIFO，RR 。

### FIFO

又叫先来先服务，first come，first served

用一个链表记录所有任务，依次取出任务执行。

最先进入runnable状态的任务将首先获取CPU资源，并且一直占用该资源，直到该任务让出CPU。

| 优点 | 简单 |
| --- | --- |
| 缺点 | 花费时间少的任务可能排在花费时间长的任务后面，平均周转时间波动较大 。 |
| 周转时间 | 一个任务从初始化到结束所花费的时间；周转时间 = 等待时间 + 运行时间 |

### Round robin轮循

轮询调度算法的原理是按照时间片分配CPU资源。

当某个RR任务开始运行后，如果该任务不会阻塞，那么它将一直运行，直到分配给该任务的时间片到期。

| 优点 | 平均响应时间短 |
| --- | --- |
| 缺点 | 选择一个合适的时间片大小；    如果时间片太大，则等待时间过长    如果时间片太小，虽然反应迅速，但是上下文切换开销大；    经验值：维持上下文切换开销处于时间片的1%以内 |

### RT 优先级

FIFO，RR 都是RT （real time) 调度，一般配合优先级使用。

根据任务 的优先级进行调度。

最高优先级的任务将最先获得CPU资源，高优先级任务让出CPU后，低优先级任务才有机会运行。

规则1: 如果A的优先级 > B 的优先级，运行A （不运行B）。

规则2: 如果A的优先级 = B 的优先级 ，轮流运行A和B。

当任务优先级相同时 ：

FIFO调度器，最先进入runnable状态的任务将首先获取CPU资源，并且一直占用该资源，直到该任务让出CPU。

RR调度器，具有相同优先级的任务将以轮流执行的方式共享处理器资源。当某个RR任务开始运行后，如果该任务不会阻塞，那么它将一直运行，直到分配给该任务的时间片到期。

### CFS完全公平调度策略

调度策略的设计要考虑公平性，所以我们引入了CFS完全公平调度策略 Completely Fair Scheduler。

| 目的 | 让所有任务公平的使用CPU |
| --- | --- |
| 策略 | 1. 记录下每个task 使用cpu 的时间 2. 每次调度的时候,现在已消耗时间最少的task |
| 好处 | 1. 防止个别应用程序 创建高优先级的任务长期占用cpu ,导致其他任务无法获得cpu 运行。 2. 应用程序开发人员不用考虑线程优先级的设置，统一交给操作系统来管理。 3. 随着应用程序创建越来越多的线程，这个优势会越来越明显 |

CFS调度器和RR调度器不同之处在于没有时间片的概念，而是分配cpu使用时间的比例。例如：2个相同优先级的任务在一个cpu上运行，那么每个任务都将会分配50%的cpu运行时间，如果是 4 个任务，每个任务就会被分配25% 的CPU时间。这就是要实现的公平

#### CFS 实现方案

使用 红黑树数据结构存储，每个task使用cpu 的时间。最左侧的叶子节点是时间最小的节点，也就是下一次调度的任务。

![](/images/k8s-cpu-request-limit/2.png)

红黑树数据结构存储的是虚拟运行时间。

#### 虚拟运行时间

CFS 不直接使用优先级而是将其用作允许任务执行的时间的衰减系数。低优先级任务具有更高的衰减系数，而高优先级任务具有较低的衰减系数。这意味着与高优先级任务相比，低优先级任务允许任务执行的时间消耗得更快。

![](/images/k8s-cpu-request-limit/3.png)

虚拟运行时间 = 真实运行时间 * 1024 /权重。

权重大，其虚拟时钟比真实时钟跑得慢，但获得比较多的运行时间；反之，权重小，其虚拟时钟比真实时钟跑得快。

**换算公式**

> 这部分公式换算细节可以忽略阅读

![](/images/k8s-cpu-request-limit/4.png)

```
公式1:
进程运行时间 = 调度周期 * 进程权重 / 所有进程权重之和
```

比如只有两个进程A, B，权重分别为1和2，调度周期设为30ms，那么分配给A的CPU时间为:30ms *(1/(1+2)) = 10ms；而B的CPU时间为：30ms*(2/(1+2)) = 20ms。那么在这30ms中A将运行10ms，B将运行20ms

```
公式2：
vruntime = 进程运行时间 * NICE_0_LOAD / 进程权重
```

NICE_0_LOAD表示nice为0的进程的权重,也就是说，所有进程都以nice为0的进程的权重1024作为基准,以上面AB两个进程为例，B的权重是A的2倍，那么B的vruntime增加速度只有A的一半

把公式2中的实际运行时间用公式1来替换，最终得到

```
vruntime = (调度周期 * 进程权重 / 所有进程总权重) * NICE_0_LOAD / 进程权重
vruntime = 调度周期 * NICE_0_LOAD / 所有进程总权重
```

权重由nice值确定，具体的，权重跟进程nice值之间有一一对应的关系，可以通过全局数组prio_to_weight来转换，nice值越大，权重越低。

```
nice值共有40个，与权重之间，每一个nice值相差10%左右。
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

**CFS 执行流程图**

![](/images/k8s-cpu-request-limit/5.png)

- 根据各个任务的权重值，将运行时间runtime转换成虚拟运行时间vruntime；
- 根据虚拟运行时间的大小，插入到CFS红黑树中，虚拟运行时间少的调度实体放置到左边；
- 在下一次任务调度的时候，选择虚拟运行时间少的调度实体来运行；

CPU CFS 小结

- CFS = RR 基础上加权 vruntime。
- 每个task 根据权重计算出 vruntime 的增长速率,从而达到高优任务能享受到CPU资源。
- vruntime 最小的 task 会获得更早的调度,也就是说 CFS 尽可能的保证所有task 的 vruntime都一致,权重高的 Task vruntime 提升慢,容易被优先调度,权重低的 task vruntime 提升快，反而容易被轮空。

## K8S cpu request,limit 映射过程

在最开始我们说过 k8s pod cpu reqeusts 和limits 会映射到 cpu.shares,我们先跟踪一下源码确认.

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

milliCPUToShares：

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

一张表描述上面代码的关系:

| docker 参数 | 处理过程 |
| --- | --- |
| cpuShares | 如果requests.cpu为0且limits.cpu非0，以limits.cpu为转换输入值，否则从request.cpu为转换输入值。转换算法为：如果转换输入值为0，则设置为minShares == 2， 否则为reqeusts.cpu*1024/100 |
| cpuQuota,   cpuPerid | 由limits.cpu 转换而来，默认cpuPeriod为100ms，而cpuQuota为limits.cpu的核数 * 100ms，这是一个硬限制 |

**小结**

- k8s request.cpu = docker cpu.shares
- k8s limit.cpu = docker cpu.quota

## Linux control group

LInux control group (cgroup),它由Google工程师提出，并于2008年1月加入到Kernel 2.6.24中。它的话题和模块很多,这里我们只讨论cpu 模块。

### cpu.shares

该文件值就是权重,参与 CFS vruntime 消耗速率计算。

### cpu.cfs_period_us , cpu.cfs_quota_us

- cfs_period_us 是得到调度的周期,单位微妙(us)
- cpu.cfs_quota_us 是在这个周期内绝对CPU时长,单位微妙(us)

两个文件配合起来设置CPU的使用上限,cfs_period_us的取值范围为1毫秒（ms）到1秒（s），cfs_quota_us的取值大于1ms即可，如果cfs_quota_us的值为-1（默认值），表示不受cpu时间的限制。下面是几个例子：

```cpp
1.限制只能使用1个CPU（每250ms能使用250ms的CPU时间）
    # echo 250000 > cpu.cfs_quota_us /* quota = 250ms */
    # echo 250000 > cpu.cfs_period_us /* period = 250ms */

2.限制使用2个CPU（内核）（每500ms能使用1000ms的CPU时间，即使用两个内核）
    # echo 1000000 > cpu.cfs_quota_us /* quota = 1000ms */
    # echo 500000 > cpu.cfs_period_us /* period = 500ms */

3.限制使用1个CPU的20%（每50ms能使用10ms的CPU时间，即使用一个CPU核心的20%）
    # echo 10000 > cpu.cfs_quota_us /* quota = 10ms */
    # echo 50000 > cpu.cfs_period_us /* period = 50ms */
```

从CFS 中我们看出来进程被调度的机会取决于 vruntime 的消耗的速率，也就是 weight，而在 cgroup 中 weight 就是 cpu.shares。也就是说 cpu.shares 决定进程获得 CPU 被调度的“机会”。

- cpu.shares 对应权重值影响 CFS vruntime 的消耗速率。
- cpu.cfs_perid_us 是获得调度机会之后,的调度周期(ms)。
- cpu.cfs_quota_us 是在这个调度周期内绝对的 cpu 时长(ms)。
- cpu.shares 实现 k8s cpu request。
- cpu.cfs_perid_us 和 cpu.cfs_quota_us 配合实现 k8s cpu limit。

## 总结

A: k8s pod cpu requests && limits 到底是什么?

Q: Request 本质是Pod能使用CPU的权重，Limit本质是限制Pod单位时间使用CPU的时间片

A: 为什么测试环境 cpu request 可以设置成 limit 的二分之一甚至三分一?

Q: 因为 request 默认情况下等同于 node 的 cpu 资源，而k8s 调度器只认这个静态账本,也就是一台 node 100C,分配完了就再不能上去新的pod,而实际上大部分应用CPU 并不会100% 用完，翻译过来就是从整个集群的维度去看每台 node 的CPU 使用率很低。于是就有一个矛盾点, 集群管理员看到整个集群节点CPU 使用率很低，很浪费，而 k8s 的分配率却已经满了。这时候不重要的测试环境就可以将 request 设置成 limit 的二分之一，就能再多部署一倍的 pod 。(极端点 reqeust 0.1C limit 4C, 不推荐这么玩)

A: 为什么生产环境必须 cpu request 等于 limit？

Q: 因为在 kubelet 创建 pod 的时候，对每个pod 分三个 QOS 保障等级, request==limit 是最高QOS 保障等级。而不同会降低一个QOS 等级，而都不设置就是最低 QOS 等级。

A: 从上面说 cpu request 小于 limit 就能部署更多的 pod,那这个叫超卖吗?

Q:不能！超卖本质是改变分配率的上限(>100%)，降配顶多是提高分配率。并且降配方式存在一些弊端！

比如：request=0.1c limit=4c

弊端：

- Cpu权重压制失效：资源紧张时，原低R也可抢原高R的算力。
- 调度器策略失效：多个CPU密集型Pod可能调度到同一个节点，导致节点过载。
- 进程核心数感知失效：比如JVM感知自己只能使用1个CPU，影响服务稳定。
- Pod的Qos-Class被降级：进程组被Burstable的cpu.share值压制。
- 降配需要逐个App做调整，评估降配比就非常困难了，并且调度后还没法修改。

CFS 具体细节算法和 CGroup 比较复杂,如有错误请谅解，核心意思的表达应该是没问题。

---

*本文首发于公众号「算法 SRE」，[原文链接](https://mp.weixin.qq.com/s/1rtxBv87CAUvNMzcJtYlkg)。*
