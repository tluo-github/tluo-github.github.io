---
title: "Binpack 2.0: Fixing Resource Fragmentation in Kubernetes"
description: "After running for a while, the default scheduler leaves lots of CPU fragments and large pods keep getting stuck in Pending. This post enhances the binpack algorithm to reclaim fragments without sacrificing stability, with test data from a production resource pool."
pubDate: 2022-12-09
tags: ["Kubernetes", "Scheduling"]
---

> With everyone pushing to cut costs, how do you save resources without sacrificing stability? This post presents a low-cost approach: an enhanced Binpack algorithm that tackles resource fragmentation in Kubernetes.

After the default Kubernetes scheduler has been running for a while, resource fragments always appear. This gets worse when some workloads use large pod specs and others use small ones: small pods make fragmentation much more severe.

Note: "resource fragmentation" means a large block of resources gets carved up by small pods into small leftover pieces, which large pods can no longer use.

![](/images/k8s-binpack/1.png)

## The real-world situation

Resource distribution of one algorithm resource pool in production, cpu-algo-common:

![](/images/k8s-binpack/2.png)

| Date | Nodes | Pods | Apps with zero buffer | CPU allocation | Unallocated cores | Avg. utilization |
| --- | --- | --- | --- | --- | --- | --- |
| 08-28 | 428 | 11088 | 23 | 84% | 3282 | 22% |
| 09-25 | 482 | 12116 | 62 | 89.5% | 3084 | 24% |

The algorithm pool had 80% of its CPU allocated and 43% of its memory, yet CPU utilization was only about 20%: the pool was full of CPU fragments. Every node had 15–25 idle cores, but pods in this pool are generally large. The biggest ones request 30 cores and 50 GB, and many request more than 25 cores, so none of them can use a fragment smaller than 25 cores. And since this pool has the most nodes, 425 at the time, the waste from fragmentation was very significant overall.

On top of that, large pods frequently got stuck in Pending, which forced pointless scale-outs. After running for a while, the newly added nodes became fragmented too and again couldn't fit large pods, so the quality of the whole cluster's resources kept getting worse. The end result: the node count kept growing, and so did the number of apps that couldn't get enough resources.

## The solution

There are generally two ways to fight fragmentation:

1. Use the binpack algorithm. The side effect is that an app's replicas get concentrated on a few nodes and create hot spots (sacrificing stability).
2. Use dynamic programming to build a pre-scheduling engine plus rescheduling (a heavy change with a long timeline).

Given the constraints, we wanted quick results without sacrificing stability, so we decided to enhance the binpack algorithm.

The rough idea: stop chasing absolute binpack packing, and before binpack runs, force up the weight of pod anti-affinity.

In detail:

```
When the app's replica dispersion is > 60%, use strong binpack;
When dispersion is > 50% but < 60%, use weak binpack;
When dispersion is < 50%, use reverse binpack, but drop the top 10% of nodes
```

With this logic we keep apps spread out, so an app's replicas don't all pile onto the same node, while still packing small fragments together as much as possible. The large blocks this frees up can be kept as buffer for large pods, or reclaimed by SRE to save costs. Two birds with one stone!

Example 1:

![](/images/k8s-binpack/3.png)

Example 2:

![](/images/k8s-binpack/4.png)

## Test report

Node setup for the test

| Nodes | Node CPU | Node GPU | Node memory | Max pods | Total CPU | Total pods |
| --- | --- | --- | --- | --- | --- | --- |
| 466 | 64C | 32G | 256G | 140 | 29824 | 65240 |

Pod setup for the test (simulating app specs in the algorithm resource pool)

| Request CPU | Apps | Replicas | Total CPU | Total pods |
| --- | --- | --- | --- | --- |
| Online pods |  |  |  |  |
| 7.5 | 1 | 2 | 15 | 2 |
| 0.5 | 1 | 3 | 1.5 | 3 |
| 1.5 | 1 | 4 | 6 | 4 |
| 8 | 60 | 10 | 4800 | 600 |
| 6 | 59 | 3 | 106 | 177 |
| 5 | 4 | 10 | 200 | 40 |
| 30 | 10 | 2 | 600 | 20 |
| 29 | 30 | 4 | 3480 | 120 |
| 22 | 1 | 2 | 44 | 2 |
| 2 | 5 | 60 | 600 | 300 |
| 15 | 25 | 10 | 3750 | 250 |
| 14 | 51 | 3 | 2142 | 153 |
| 12 | 2 | 4 | 96 | 8 |
| 10 | 146 | 3 | 4380 | 438 |
|  |  |  | 20176 | 2117 |
|  |  |  |  |  |
| Small pods |  |  |  |  |
| 0.5 | 533 | 3 | 799.5 | 1599 |
| 0.25 | 4 | 1 | 1 | 4 |
| 1.5 | 11 | 1 | 16.5 | 11 |
| 1 | 52 | 1 | 52 | 52 |
|  |  |  | 869 | 1666 |
|  |  |  | 21176 (71%) |  |
|  |  |  |  |  |
| Large pods |  |  |  |  |
| 22 | 30 | 2 | 1320 | 60 |
| 25 | 30 | 2 | 1500 | 60 |
| 29 | 30 | 2 | 1740 | 60 |
| 30 | 30 | 2 | 1800 | 60 |
|  |  |  | 6360 | 240 |

**Test procedure**

1. Deploy all background pods first, using 21,176 of the 29,824 cores (71%).
2. Once all background pods are Running, deploy all the large pods.
3. Collect the results.

**Results**

| Scenario | Running | Pending | Dispersion |
| --- | --- | --- | --- |
| Reverse binpack | 0 | 240 | 100 (fully spread) |
| Standard binpack | 205 | 35 | 0 (fully packed) |
| Binpack 2.0 | 209 | 31 | 100 (fully spread) |

Reverse binpack (spread)

![](/images/k8s-binpack/5.png)

Standard binpack (packed)

![](/images/k8s-binpack/6.png)

Our Binpack 2.0 (balanced)

![](/images/k8s-binpack/7.png)

## Summary

1. Binpack 2.0 gets both the spreading effect and the packing effect, without binpack's hot-spot problem.
2. While keeping replicas spread out, Binpack 2.0 cuts the number of Pending pods by 87%.
3. In this test it saved 5,850 cores, a 91% improvement.

Binpack 2.0 sample code:

https://github.com/tluo-github/kube-scheduler-plugins

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/ST4T5FoJ6Hpg8nsOnf6mMg)).*
