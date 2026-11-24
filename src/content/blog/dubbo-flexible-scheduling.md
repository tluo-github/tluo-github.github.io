---
title: "dubbo 柔性调度"
description: "混部超卖让下游节点性能时好时坏，轮询和随机都不再均衡。本文介绍基于 EMA 感知 RT、动态调整权重的 Dubbo 负载均衡扩展 EmaLoadBalance，以及它的预热、优雅下线和接入方式。"
pubDate: 2025-07-29
tags: ["Dubbo", "Java", "负载均衡"]
---

> 本文即开源项目 [dubbo-cluster-loadbalance-ema](https://github.com/tluo-github/dubbo-cluster-loadbalance-ema) 的说明文档。

## 一、背景

最常见的分流算法是 Round Robin 和随机。这两个方法的前提是下游的机器和网络都是类似的，但在目前的线上环境下，特别是混部的场景中，已经很难成立，因为：

- 动态资源变化：每台机器运行着不同的程序组合，还伴随离线任务的执行，导致可用资源持续动态变化。
- 硬件配置差异：下游机器的配置可能不一致，性能差距显著。
- 网络延迟波动：网络质量不可控，部分节点可能因延迟问题而影响整体性能。

在各业务场景中，RT 抖动问题普遍存在，其成因复杂，排查耗费大量精力，难以在成本和收益间找到平衡。根据近几年观察，导致 RT 抖动的主要原因包括：

- GC 问题：大缓存的使用导致 JVM 垃圾回收引擎性能瓶颈，引发业务 RT 毛刺。
- 性能波动：特殊业务逻辑（如定时任务、巨量 IO 日志、低效第三方库等）触发性能波动。
- 资源隔离不足：容器调度至不健康节点或受其他业务干扰，引起显著 RT 倾斜，甚至 OOM。
- 预热不足：JVM、缓存、连接池等资源预热不到位，导致冷启动期间的 RT 波动。

这些问题促使我们寻找一种高效且通用的解决方案。emaLoadBalance 是基于 Dubbo 的自研扩展型 LoadBalance 算法，支持预热机制和优雅下线，通过引入指数移动平均（EMA）算法，能够快速感知下游实例的响应时间（RT）变化，动态调整流量分配策略，为系统提供更高的性能和稳定性。

## 二、特性与收益

- 实时流量控制：通过 EMA 算法动态调整 Pod 权重，根据 RT 压力实时分配流量，减少 RT 抖动。
- 下游预热感知：Pod 启动时逐步提升权重，大幅降低下游服务发布感知。
- 资源分区优化：基于注册中心分区标识，实现就近分配，支持跨分区负载均衡。
- 优化计算性能：重写 Dubbo 客户端过滤器，减少约 4ms 的指标统计性能损耗。
- 优雅下线机制：提前降低下线 Pod 权重，避免流量误转，减少 RT99 峰值波动。
- 错误惩罚机制：对限流、超时、错误的 Pod 降低权重，促进自我恢复。
- 灵活调试支持：支持通过 ARK 配置中心控制灰度、自定义权重调试、自定义偏移阈值。
- 紧急一键降级：在发现负载均衡问题时，支持通过 ARK 配置中心在线紧急降级。

## 三、方案思路

服务 RT 倾斜、抖动原因太多，可能是混部超卖、可能是代码逻辑、可能是发布预热、可能是框架缺陷、可能是 GC 问题……这里面有的因素业务可以解决，但有些因素业务死活都不可能解。既然正面无法解，那就换个思路，接受事实，换个逆向的方式来解：解决不了问题，那么就“屏蔽”问题。

关于 RT 异常问题，我们思考过一段时间。结论是：负载均衡算法，目前是 ROI 最优办法。

![方案概览](/images/dubbo-flexible-scheduling/overview.png)

服务接入负载均衡模块后，上游将获得最优 RT。如果每一层都接入，链路中间层的异常 RT 会高概率被屏蔽，那么入口层服务将获得整体 RT 最优。

![逐层接入后的效果](/images/dubbo-flexible-scheduling/overview-2.png)

EmaLoadBalance 相比其他 LoadBalance，通过 EMA 感知 RT，动态降低高 RT 实例的权重，从而减少发往高 RT 实例的流量。

## 四、原理介绍

EmaLoadBalance 是基于 EMA（指数移动平均）的负载均衡算法，通过对响应时间的动态计算与权重分配，实现柔性流量调度。完整的核心原理如下：

![权重计算公式](/images/dubbo-flexible-scheduling/1.png)

预热公式的曲线如下：一开始只有少部分流量缓慢进来，中后期预热流量拉升，同时触发 JIT 完成预热。

![预热曲线](/images/dubbo-flexible-scheduling/overview-3.png)

## 五、接入使用方法

Step 1：在 pom.xml 中添加如下依赖

```xml
<dependency>
    <groupId>org.apache.dubbo.extensions</groupId>
    <artifactId>dubbo-cluster-loadbalance-ema</artifactId>
    <version>1.0.0-RELEASE</version>
</dependency>
```

Step 2：配置启用 EmaLoadBalance

```xml
<dubbo:reference id="demoService"
                 loadbalance="ema"/>
```

### 紧急降级

在 ARK 上配置 `dubbo.loadbalance.ema.switch=false`，可以动态降级成默认的随机 LB。

```properties
# 是否启用 ema lb，默认为 true，为 false 将会降级走默认随机 lb
dubbo.loadbalance.ema.switch=true
```

## 六、QA

### 单机限流是否有问题？

当 RT 倾斜，万一触发一个节点的 QPS 单机限流，是否有问题？就算触发单机限流也不会造成问题。Dubbo 在处理异常、超时、限流时会经过 DwEmaLoadBalanceFilter 的 onError 回调函数，在 onError 函数里，我们做了快速降低权重的策略。

### 是否支持自定义权重？

支持，并且支持 ARK 动态配置更新，无需重启。

### 会不会导致负载不均衡？

会。当下游 RT 长期不均衡的时候，调用量会不均衡。比如 2 个下游 Pod，第一个 Pod 返回的 RT 为 20ms，第二个 Pod 返回的 RT 为 60ms，那么给第一个 Pod 的调用量会比第二个多三倍。RT 恢复后流量就会恢复。

### 会不会有部分 Pod 流量长期跌 0？

不会。本质是一个概率优选过程，不会导致绝对不经过流量，只要 RT 逐渐恢复，流量就会逐渐上来。即使某个实例全部失败，也会保持低概率；当所有实例 RT 都上升或者都失败的时候，相当于权重恢复平等。

### 是否支持 Dubbo 上线预热？

支持。

### 是否支持 Dubbo 优雅下线？

支持。

## 七、快速排查

Dubbo Telnet 调试机制：

```bash
# 第一步，进入 dubbo telnet 调试模式
telnet localhost 20880

# 查看当前 ema lb 配置开关
ema configs

# 查看当前下游服务
ema keys

# 查看当前所有内部数据
ema metrics

# 查询指定下游 IP 内部数据
ema IP
```

Arthas 快查指令：

```bash
# 查看 ema lb 开关，输出为 true 为【开启】，输出为 false 为【关闭】
watch org.apache.dubbo.extensions.ema.config.EmaArkConfig enableEmaSwitch -n 1

# 查看是否进入 EmaLoadBalance，有内容输出代表进入
watch org.apache.dubbo.extensions.ema.loadbalance.EmaLoadBalance doSelect -n 1

# 查看是否降级进入随机 LB，有内容输出代表进入降级
watch org.apache.dubbo.extensions.ema.loadbalance.RandomLoadBalanceWrapper select '{params, returnObj}' -x 3 -n 1

# 查看后端 invoker 数量
watch org.apache.dubbo.extensions.ema.loadbalance.EmaLoadBalance doSelect '{params[0].size()}' -x 3 -n 1

# 查看内部监控数据
sc -d -f org.apache.dubbo.extensions.ema.rpc.EmaMetrics
```

## 八、源码与测试项目

- 源码：[tluo-github/dubbo-cluster-loadbalance-ema](https://github.com/tluo-github/dubbo-cluster-loadbalance-ema)
- 测试项目：[tluo-github/dubbo-loadbalance-test](https://github.com/tluo-github/dubbo-loadbalance-test)

---

*本文首发于公众号「算法 SRE」，[原文链接](https://mp.weixin.qq.com/s/4OEd6J9RwsHAlXUoCkRACQ)。*
