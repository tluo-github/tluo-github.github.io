---
title: "Adaptive Load Balancing for Dubbo"
description: "On co-located, overcommitted nodes, downstream performance keeps shifting, so round robin and random no longer balance well. This post introduces EmaLoadBalance, a Dubbo extension that senses RT with EMA and adjusts weights on the fly, plus its warm-up, graceful shutdown and setup."
pubDate: 2025-07-29
tags: ["Dubbo", "Java", "Load Balancing"]
---

> This post is the documentation of the open-source project [dubbo-cluster-loadbalance-ema](https://github.com/tluo-github/dubbo-cluster-loadbalance-ema).

## 1. Background

The most common traffic-splitting algorithms are round robin and random. Both assume that downstream machines and networks are roughly identical. In today's production environments, and especially with co-located workloads, that assumption rarely holds, because of:

- Shifting resources: every machine runs a different mix of programs, plus offline jobs, so available resources keep changing.
- Hardware differences: downstream machines may have different specs, with significant performance gaps.
- Network latency jitter: network quality is out of our control, and slow nodes can drag down overall performance.

RT (response time) jitter shows up in every business scenario. Its causes are complex, troubleshooting takes a lot of effort, and it is hard to find the right balance between cost and benefit. From what we have observed over the past few years, the main causes of RT jitter are:

- GC: large in-memory caches push the JVM garbage collector to its limits and cause RT spikes.
- Performance fluctuation: special business logic (scheduled jobs, massive IO logging, inefficient third-party libraries, etc.) causes performance swings.
- Weak resource isolation: containers land on unhealthy nodes or are disturbed by other workloads, causing severe RT skew or even OOM.
- Insufficient warm-up: the JVM, caches and connection pools are not warmed up, causing RT fluctuation during cold start.

These problems pushed us to look for an efficient, general-purpose solution. emaLoadBalance is an in-house LoadBalance extension for Dubbo. It supports warm-up and graceful shutdown, and by using an exponential moving average (EMA) it quickly picks up changes in the response time (RT) of downstream instances and adjusts traffic allocation on the fly, giving the system better performance and stability.

## 2. Features and benefits

- Real-time traffic control: EMA dynamically adjusts pod weights and allocates traffic according to RT pressure, reducing RT jitter.
- Warm-up awareness: a pod's weight ramps up gradually after it starts, so downstream releases are barely noticeable.
- Zone-aware routing: uses zone labels from the registry to prefer nearby instances, with cross-zone load balancing supported.
- Lower overhead: a rewritten Dubbo client filter removes about 4 ms of metrics overhead.
- Graceful shutdown: lowers the weight of pods that are going offline ahead of time, avoiding misrouted traffic and reducing RT99 spikes.
- Error penalty: pods that are rate-limited, time out or return errors get lower weights, which helps them recover.
- Flexible debugging: gray release, custom weights and custom offset thresholds can all be controlled through the ARK config center.
- One-click fallback: if something goes wrong with load balancing, it can be switched off online through the ARK config center.

## 3. The approach

There are far too many reasons for RT skew and jitter: overcommitted co-located nodes, code logic, warm-up during releases, framework bugs, GC… Some of these can be fixed by the service owners, but some simply cannot. Since we can't fix them head-on, we flip the problem around and accept reality: if we can't solve the problem, we "shield" it.

We thought about RT anomalies for a while, and our conclusion was that load balancing is currently the option with the best ROI.

![Overview of the approach](/images/dubbo-flexible-scheduling/overview.png)

Once a service adopts the load balancing module, its callers get the best possible RT. If every layer adopts it, abnormal RT in the middle of a call chain is very likely to be shielded, and the entry service gets the best overall RT.

![The effect of adopting it layer by layer](/images/dubbo-flexible-scheduling/overview-2.png)

Compared with other LoadBalance implementations, EmaLoadBalance senses RT through EMA and dynamically lowers the weight of high-RT instances, so less traffic is sent to them.

## 4. How it works

EmaLoadBalance is a load balancing algorithm based on EMA (exponential moving average). By continuously computing response times and assigning weights accordingly, it achieves adaptive traffic scheduling. The complete core formula is:

![Weight formula](/images/dubbo-flexible-scheduling/1.png)

The warm-up curve is shown below: at first only a small share of traffic trickles in, then traffic ramps up in the middle and late stages, which also triggers JIT compilation to complete the warm-up.

![Warm-up curve](/images/dubbo-flexible-scheduling/overview-3.png)

## 5. Getting started

Step 1: add the following dependency to pom.xml

```xml
<dependency>
    <groupId>org.apache.dubbo.extensions</groupId>
    <artifactId>dubbo-cluster-loadbalance-ema</artifactId>
    <version>1.0.0-RELEASE</version>
</dependency>
```

Step 2: enable EmaLoadBalance

```xml
<dubbo:reference id="demoService"
                 loadbalance="ema"/>
```

### Emergency fallback

Setting `dubbo.loadbalance.ema.switch=false` in ARK dynamically falls back to Dubbo's default random load balancer.

```properties
# Whether ema lb is enabled. Defaults to true; false falls back to the default random lb
dubbo.loadbalance.ema.switch=true
```

## 6. FAQ

### Is per-instance rate limiting a problem?

If RT is skewed and an instance hits its own QPS limit, is that a problem? No. When Dubbo handles exceptions, timeouts or rate limiting, it goes through the onError callback of DwEmaLoadBalanceFilter, and in onError we quickly lower that instance's weight.

### Can I set custom weights?

Yes, and they can be updated dynamically through ARK without a restart.

### Will it cause uneven load?

Yes. When downstream RT stays uneven for a long time, call volume will be uneven too. For example, with 2 downstream pods where the first returns in 20 ms and the second in 60 ms, the first pod gets three times as many calls as the second. Once RT recovers, traffic recovers.

### Can a pod's traffic drop to zero for a long time?

No. It is essentially a probabilistic selection, so no instance is ever completely starved. As RT recovers, traffic gradually comes back. Even if an instance fails every request, it keeps a small probability of being picked, and when all instances slow down or all fail, their weights effectively become equal again.

### Does it support warm-up for Dubbo releases?

Yes.

### Does it support graceful shutdown for Dubbo?

Yes.

## 7. Troubleshooting

Debugging through Dubbo telnet:

```bash
# Step 1: enter dubbo telnet debug mode
telnet localhost 20880

# Show the current ema lb config switch
ema configs

# Show the current downstream services
ema keys

# Show all internal data
ema metrics

# Show internal data for a specific downstream IP
ema IP
```

Quick Arthas commands:

```bash
# Check the ema lb switch: true means ON, false means OFF
watch org.apache.dubbo.extensions.ema.config.EmaArkConfig enableEmaSwitch -n 1

# Check whether EmaLoadBalance is being used; any output means it is
watch org.apache.dubbo.extensions.ema.loadbalance.EmaLoadBalance doSelect -n 1

# Check whether it fell back to the random LB; any output means it did
watch org.apache.dubbo.extensions.ema.loadbalance.RandomLoadBalanceWrapper select '{params, returnObj}' -x 3 -n 1

# Show the number of backend invokers
watch org.apache.dubbo.extensions.ema.loadbalance.EmaLoadBalance doSelect '{params[0].size()}' -x 3 -n 1

# Show internal metrics
sc -d -f org.apache.dubbo.extensions.ema.rpc.EmaMetrics
```

## 8. Source code and test project

- Source: [tluo-github/dubbo-cluster-loadbalance-ema](https://github.com/tluo-github/dubbo-cluster-loadbalance-ema)
- Test project: [tluo-github/dubbo-loadbalance-test](https://github.com/tluo-github/dubbo-loadbalance-test)

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/4OEd6J9RwsHAlXUoCkRACQ)).*
