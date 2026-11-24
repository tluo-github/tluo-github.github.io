---
title: "kubernetes 网络漫谈(一)"
description: "K8S 网络入门第一篇：从 Namespace、Veth、网桥、iptables 讲 Docker 网络，再到 Flannel 的 UDP、VXLAN、host-gw 模式和 Service 的代理模型。"
pubDate: 2022-03-24
tags: ["Kubernetes", "网络"]
---

> 将从 docker 网络、kubernetes 网络、flannl 网络、ingress网络。漫谈k8s 网络入门(一)

## docker 网络

Docker 本身的技术依赖于近年 Linux 内核虚拟化技术的发展，所以 Docker 对Linux内核的特性有很强的依赖。Docker使用到的与Linux网络有关的主要技术包括以下几种：

- Liunx Network Namespace (网络命名空间)
- Veth (设备对)
- Bridge (网桥)
- Iptables/Netfilter (一般用来当防火墙)
- Router （路由）

### Network Namespace

Network namespace 主要提供了关于网络资源的隔离，包括网络设备、IPv4和IPv6的协议栈、IP路由表、防火墙、/proc/net 目录、/sys/class/net目录、套接字(socket)等。通过这种对网络资源的隔离，就能在一个宿主机上虚拟多个不同的网络环境，处在不同命名空间的网络栈是完全隔离的，彼此之间无法通行，就好像两个“平行宇宙”。而Docker 也正是利用了网络的命名空间特性，实现了不同容器之间的网络隔离。

- Linux在网络栈中引入网络命名空间(Network Namespace)为了支持网络协议栈的多个实例，处于不同命名空间的网络栈是完全隔离的
- Linux的网络命名空间内可以有自己独立的路由表及独立的Iptables/Netfilter设置来提供转发、NAT及IP包过滤等功能
- 需要纳入命名空间的元素有进程、套接字、网络设备等

Step 1. 在一台 Liunx (192.168.1.100) 实际操作 network namespace,ip netns 命名是用来操作network namespace 的指令:

```bash
# 创建一个名为 bruce  的 namespace
$ ip netns add bruce
#列出系统中存在的network namespace
$ ip netns list
bruce
#显示 bruce 的 网卡信息
$ ip netns exec bruce ip addr
# 再创建一个名为 dog 的 network namespce
$ ip netns add dog
```

### Veth 设备对

Step 2. 使用Veth 设备对，让 bruce 和 dog 通信。

```bash
# 创建Veth 设备对
$ ip link add veth_bruce type veth peer name veth_dog      
# 将veth_bruce 设备 添加到 bruce network namespace 中
$ ip link set veth_bruce netns bruce
# 将veth_dog 设备 添加到 dog network namespace 中
$ ip link set veth_dog netns dog

# 进行验证
$ ip netns exec bruce ip link
$ ip netns exec dog ip link

# 启动 bruce,dog 的lo 网卡
$ip netns exec bruce ip link set dev lo up
$ip netns exec dog ip link set dev lo up

#为 bruce 中的 veth_bruce 设置IP,并启动
$ ip netns exec bruce ip addr add 10.0.0.1/24 dev veth_bruce
$ ip netns exec bruce ip link set dev veth_bruce up

#为 dog 中的 veth_dog 设置IP,并启动
$ ip netns exec dog ip addr add 10.0.0.2/24 dev veth_dog
$ ip netns exec dog ip link set dev veth_dog up

# 分别查询 bruce 和 dog 的 ip route
$ ip netns exec bruce ip route
10.0.0.0/24 dev veth_bruce protokernel scope link src 10.0.0.1
$ip netns exec dog ip route
10.0.0.0/24 dev veth_dog proto kernel scope link src 10.0.0.2
```

这两条路由表明的意义是目的地址为10.0.0.0/24 网络的IP包分别从veth*bruce 和 veth*dog 发出。

Step 3 . 现在 bruce 和 dog 分别有了自己的网卡、IP地址、路由表等信息。已经就是一个小型的”虚拟机”。现在测试他们他们的连通性:

```
$ip netns exec bruce pint 10.0.0.2
64 bytes from 10.0.0.2:icmp_seq = 1 ttl=64 time=0.088
$ip netns exec dog pint 10.0.0.1
64 bytes from 10.0.0.1:icmp_seq = 1 ttl=64 time=0.088
```

目前我们完成了一个这样的架构。使两个独立的network namespace 并通过veth 设备对进行通信。架构图如下:

![](/images/k8s-network-1/1.png)

### Bridge 网桥

现在如果我们再创建一个network namespace ，那么这3个network namespace 之间如果互通。当必须连接两个以上的network namespce 时,应该使用交换机。Liunx 提供一个bridge 解决方案。如图:

![](/images/k8s-network-1/2.png)

```sql
# 添加 2个 namespaces
ip netns add ns1
ip netns add ns2

# 创建一个名为 br-test 的网桥，设置启动
brctl addbr br-test
brctl stp br-test off
ip link set dev br-test up

### PORT 1 操作
# 创建一个 port pair
ip link add tap1 type veth peer name br-tap1
# 将一边连接到linux bridge
brctl addif br-test br-tap1
# 将另一边连接到 ns1 namespaces
ip link set tap1 netns ns1
# 设置 ports 启动
ip link set dev br-tap1 up
ip netns exec ns1 ip link set dev tap1 up
ip link set dev br-tap1 up

### PORT 2 操作 同上
ip link add tap2 type veth peer name br-tap2
brctl addif br-test br-tap2
ip link set tap2 netns ns2
ip netns exec ns2 ip link set dev tap2 up
ip link set dev br-tap2 up

# 设置 ns1,ns2 lo 网卡启动
ip netns exec ns1 ip link set dev lo up
ip netns exec ns2 ip link set dev lo up

# 配置 br-test 网桥
ifconfig br-test 10.0.0.0/24
# 设置 namespace 中网卡ip 地址
ip netns exec ns1 ip addr add 10.0.0.1/24 dev tap1
ip netns exec ns2 ip addr add 10.0.0.2/24 dev tap2

# 测试
ip netns exec ns1 ping 10.0.0.2
ip netns exec ns2 ping 10.0.0.1
```

通过Network Namespce、Veth 设备对、Bridge 网桥,我们创建了独立的网络环境，并能各自访问，Docker 默认的网络模式也是这样，但是，我们的network namespace不能访问外面，外面也访问不了我们的network namespace。而Docker 容器是可以访问宿主机和外面的世界，也能接受外面世界的访问。而这一切的功能是交由Iptable/Netfilter来完成的。

### Iptables/Netfilter

Netfilter是Linux操作系统核心层内部的一个数据包处理模块，它具有如下功能：

- 网络地址转换(Network Address Translate)。
- 数据包内容修改。
- 以及数据包过滤的防火墙功能。
- ...

Netfilter 平台中制定了数据包的五个挂载点（Hook Point，我们可以理解为回调函数点，数据包到达这些位置的时候会主动调用我们的函数，使我们有机会能在数据包路由的时候改变它们的方向、内容），这5个挂载点分别是PRE*ROUTING、INPUT、OUTPUT、FORWARD、POST*ROUTING。

![](/images/k8s-network-1/3.png)

Netfilter 所设置的规则是存放在内核内存中的，而 iptables 是一个应用层的应用程序，它通过 Netfilter 放出的接口来对存放在内核内存中的 XXtables（Netfilter的配置表）进行修改。这个XXtables由表tables、链chains、规则rules组成，iptables在应用层负责修改这个规则文件。

![](/images/k8s-network-1/4.png)

这些挂载点能挂载的规则也分不同的类型，目前支持的规则表有

- FILTER
主要用于对数据包进行过滤，根据具体的规则决定是否放行该数据包（如DROP、ACCEPT、REJECT、LOG）。filter 表对应的内核模块为iptable_filter，包含三个规则链：
- NAT
主要用于修改数据包的IP地址、端口号等信息（网络地址转换，如SNAT、DNAT、MASQUERADE、REDIRECT）。属于一个流的包(因为包 的大小限制导致数据可能会被分成多个数据包)只会经过这个表一次。如果第一个包被允许做NAT或Masqueraded，那么余下的包都会自动地被做相同的操作，也就是说，余下的包不会再通过这个表。表对应的内核模块为 iptable_nat，包含三个链：
- MANGLE
主要用于修改数据包的TOS（Type Of Service，服务类型）、TTL（Time To Live，生存周期）指以及为数据包设置Mark标记，以实现Qos(Quality Of Service，服务质量)调整以及策略路由等应用，由于需要相应的路由设备支持，因此应用并不广泛。包含五个规则链——PREROUTING，POSTROUTING，INPUT，OUTPUT，FORWARD。
- RAW
主要用于决定数据包是否被状态跟踪机制处理。在匹配数据包时，raw表的规则要优先于其他表。包含两条规则链——OUTPUT、PREROUTING

iptables供涉及5种默认规则链，从应用时间点的角度理解这些链：

- INPUT链：当接收到防火墙本机地址的数据包（入站）时，应用此链中的规则。
- OUTPUT链：当防火墙本机向外发送数据包（出站）时，应用此链中的规则。
- FORWARD链：当接收到需要通过防火墙发送给其他地址的数据包（转发）时，应用此链中的规则。
- PREROUTING链：在对数据包作路由选择之前，应用此链中的规则，如DNAT。
- POSTROUTING链：在对数据包作路由选择之后，应用此链中的规则，如SNAT。

![](/images/k8s-network-1/5.png)

Iptables/Netfilter 小结

Iptables 是应用程序操作Liunx内核的Netfilter,来达到控制进过网卡进入主机的数据包行为。常用关闭端口，开发端口，NAT 转发等等场景。下面还介绍一个Route 路由

- PREROUTING链：作用是在包刚刚到达防火墙时改变它的目的地址
- OUTPUT链：改变本地产生的包的目的地址
- POSTROUTING链：在包就要离开防火墙之前改变其源地址

### Route 路由

Liunx 系统中包含一个完整的路由功能。当IP 层在处理数据发送或者转发的时候，会使用路由表来决定发往哪里。查看命令:

```bash
$ ip route list
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
```

这条路由标识所有目的IP 为 172.17.0.0/16 的数据包从docker0网卡发出。

### Docker Bridge 详解

在上面介绍中，网络命名空间、Veth设备对、Bridge 网桥。我们构造出了独立的网络空间，并相互通信。而 Network Namespace、Veth设备对、Bridge 网桥、Iptables/Netfilter、路由 。都是Docker 默认网络会用的到内核技术。

Docker Bridge 结构图:

![](/images/k8s-network-1/6.png)

Bridge 桥接模式，从原理上实现了Docker 容器 到宿主机乃至其他机器的网络连通性。然而，etho0,docker0,veth pair,的IP地址均不在同一个网段。故依靠namespace,veth,bridge技术还不足以是宿主机以外的网络主动发现Docker Container的存在。为了使得Docker Container可以让宿主机以外的世界感知到容器内部暴露的服务，Docker采用NAT（Network Address Translation，网络地址转换）的方式，让宿主机以外的世界可以主动将网络报文发送至容器内部。也就是对上面介绍的Iptable/Netfilter进行操作。如下图所示关键部分在NAT

![](/images/k8s-network-1/7.png)

### 外部访问容器

当宿主机以外的世界需要访问容器时，数据包的流向如下图所示：

![](/images/k8s-network-1/8.png)

由于容器的 IP 与端口对外都是不可见的，所以数据包的目的地址为宿主机的 ip 和端口。数据包经过路由器发给宿主机 eth0，再经 eth0 转发给 docker0 网桥。由于存在 DNAT 规则，会将数据包的目的地址转换为容器的 ip 和端口，为 172.17.0.n:24 。宿主机上的 docker0 网桥识别到容器 ip 和端口，于是将数据包发送附加到 docker0 网桥上的 veth0 接口，veth0 接口再将数据包发送给容器内部的 veth1 接口，容器接收数据包并作出响应。

![](/images/k8s-network-1/9.png)

### 容器访问外部网络

当容器需要访问宿主机以外的世界时，数据包的流向为下图所示：

![](/images/k8s-network-1/10.png)

此时数据包的源地址为容器的 ip 和端口，为 172.17.0.n:24，容器内部的 veth1 接口将数据包发往 veth0 接口，到达 docker0 网桥。宿主机上的 docker0 网桥发现数据包的目的地址为外界的 IP 和端口，便会将数据包转发给 eth0 ，并从 eth0 发出去。由于存在 SNAT 规则，会将数据包的源地址转换为宿主机的 ip 和端口。

由于路由器可以识别到宿主机的 ip 地址，所以再将数据包转发给外界，外界接受数据包并作出响应。这时候，在外界看来，这个数据包就是从 物理机网卡 上发出来的，Docker 容器对外是不可见的。

![](/images/k8s-network-1/11.png)

### Docker Bridge 网络 容器与外部通信小结

从上述所知，容器内部与外部的网络进出，关键点在DNAT,SNAT, 也就是 NAT（Network Address Translation，网络地址转换）的方式。这种方式的实现靠的就是使用Iptables的操作。

```
$ iptables-save #查看nat 表上的POSTROUTING 链,其中有一条
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
```

这条规则会将源地址为 172.17.0.0/16 的包（也就是Docker 容器产生的包），并不是从docker0网卡发出的，进行源地址转换(SNAT),转换成主机网卡的地址。也就是实现容器能够访问外部网络的核心原理实现。

而外部访问容器也是原地址转换,首先启动一个web 容器,映射8080 端口

```
docker run -d --name web -p 2376:80 fmzhen/simpleweb
```

然后查看iptables 规则 就会有 *nat

```
-A DOCKER ! -i docker0 -p tcp -m tcp --dport 2376 -j DNAT --to-destination 172.17.0.8:80
```

这条规则就是对主机echo0 收到的目的端口2376 的TCP 流量做DNAT 转换,将流量发往172.17.0.8:80，所以我们外部只需要访问 echo0的 IP:2376 就转发到了容器内容。

### Docker 网络 总结

Docker Network Model 默认是使用 Bridge ,我们详细跟踪这一模式的实现。通过Liunx network namespace ,创建 独立的网络空间。通过 Veth pair 设备对让网络空间与主机通信，通过 brrdge 桥，让 多个 namespace 空间通信，通过 iptables 让 namespace 与外部通信。

```
$ ip route list
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
```

这条路由标识所有目的IP 为 172.17.0.0/16 的数据包从docker0网卡发出。

## kubernetes 网络

Kubernetes 网络本身就要达到几个目的：

1. 容器与容器能够通信
2. Pod 与 Pod 能够通信
3. Pod 与 Service 能够通信
4. Service 与 外部 能够通信。

反观Docker 的 默认 Bridge 网络，有2个确定，容器不能直接跨主机通信，得通过主机的NAT端口转发。而NAT 端口转发在多主机及多端口的情况下又很难管理。所有Kubernets 对网络提出了几点通信要求，但并不是Kubernetes 自己实现，要求如下:

1. 所有容器都可以与所有其他容器通信而无需NAT。
2. 所有节点主机都可以与所有容器通信（反之亦然），无需NAT。
3. 每个容器都有一个独一无二的IP。

Kubernets 规定了要求及规范CNI (Container Network Interface)，其他技术以插件的形式进行实现。

### CNI (Container Network Interface)

Container Network Interface (CNI) 最早是由CoreOS发起的容器网络规范，是Kubernetes网 络插件的基础。其基本思想为:Container Runtime在创建容器时，先创建好network namespace，然后调用CNI插件为这个netns配置网络，其后再启动容器内的进程。

Kubernetes Pod 中的其他容器都是Pod所属pause容器的网络，创建过程为:

1. kubelet先创建pause容器生成networknamespace 2. 调用网络CNIdriver
2. CNIdriver根据配置调用具体的cni插件
3. cni插件给pause容器配置网络
4. pod中其他的容器都使用pause容器的网络

![](/images/k8s-network-1/12.png)

简单理解，Kubernetes 的网络模型提出了要求，以插件的形式提供接口，谁都可以实现。

### Flannel

Flannel是CoreOS团队针对Kubernetes设计的一个网络规划服务，简单来说，它的功能是让集群中的不同节点主机创建的Docker容器都具有全集群唯一的虚拟IP地址。

在默认的Docker配置中，每个节点上的Docker服务会分别负责所在节点容器的IP分配。这样导致的一个问题是，不同节点上容器可能获得相同的内外IP地址。并使这些容器之间能够之间通过IP地址相互找到，也就是相互ping通。

Flannel的设计目的就是为集群中的所有节点重新规划IP地址的使用规则，从而使得不同节点上的容器能够获得“同属一个内网”且”不重复的”IP地址，并让属于不同节点上的容器能够直接通过内网IP通信。

Flannel实质上是一种“覆盖网络(overlaynetwork)”，也就是将TCP数据包装在另一种网络包里面进行路由转发和通信，目前已经支持udp、vxlan、host-gw、aws-vpc、gce和alloc路由等数据转发方式，默认的节点间数据通信方式是UDP转发。

特点:

1. 使集群中的不同Node主机创建的Docker容器都具有全集群唯一的虚拟IP地址。
2. 建立一个覆盖网络（overlay network），通过这个覆盖网络，将数据包原封不动的传递到目标容器。覆盖网络是建立在另一个网络之上并由其基础设施支持的虚拟网络。覆盖网络通过将一个分组封装在另一个分组内来将网络服务与底层基础设施分离。在将封装的数据包转发到端点后，将其解封装。
3. 创建一个新的虚拟网卡flannel0接收docker网桥的数据，通过维护路由表，对接收到的数据进行封包和转发（vxlan）。
4. etcd保证了所有node上flanned所看到的配置是一致的。同时每个node上的flanned监听etcd上的数据变化，实时感知集群中node的变化。

#### UDP

![](/images/k8s-network-1/13.png)

当容器100.96.1.2/24要和容器100.96.2.3/24通信时

1. container-1 容器里的进程发起的 IP 包，其源地址就是 100.96.1.2，目的地址就是 100.96.2.3。由于目的地址 100.96.2.3 并不在 Node 1 的 docker0 网桥的网段里，所以这个 IP 包 会被交给container-1的默认路由规则，通过容器的网关进入 docker0 网桥（如果是同一台宿主机上的容器间通信，走的是直连规则），从而出现在宿主机上。
2. 宿主机上的路由规则如下所示。IP 包的目的地址是 100.96.2.3，它匹配不到本机 docker0 网桥对应的 100.96.1.0/24 网段，只能匹配到第二条、也就是 100.96.0.0/16 对应的这条路由规则，从而进入 到一个叫作 flannel0 的设备中。
```
$ ip route
default via 10.168.0.1 dev eth0
100.96.0.0/16 dev flannel0  proto kernel  scope link  src 100.96.1.0
100.96.1.0/24 dev docker0  proto kernel  scope link  src 100.96.1.1
10.168.0.0/24 dev eth0  proto kernel  scope link  src 10.168.0.2
```
3. 当操作系统将一个 IP 包发送给 flannel0 设备之后，flannel0 就会把这个 IP 包，交给创建这个设备的应用程序，也就是 Flannel 进程。这是一个从内核态（Linux 操作系统） 向用户态（Flannel 进程）的流动方向。(需要注意的是flannel0是一个tun设备，它是一种工作在三层的虚拟网络设备，而flanneld是一个proxy，它会监听flannel0并转发流量。)
4. flanneld 进程在处理由 flannel0 传入的 IP 包时，就可以根据数据包的目的 IP 的地址（比如 100.96.2.3），匹配到对应的子网（比如 100.96.2.0/24），从 Etcd 中找到这个子网对应的宿主机 的 IP 地址是 10.168.0.3。如下所示：
```
$ etcdctl get /coreos.com/network/subnets/100.96.2.0-24
{"PublicIP":"10.168.0.3"}
$ etcdctl ls /coreos.com/network/subnets
/coreos.com/network/subnets/100.96.1.0-24
/coreos.com/network/subnets/100.96.2.0-24
/coreos.com/network/subnets/100.96.3.0-24
```
5. flannel进程把这个 IP 包进行二次封装，直接封装 在一个 UDP 包里，然后发送给 Node 2。，这个 UDP 包的源地址，就是 flanneld 所在 的 Node 1 的地址，而目的地址，则是 container-2 所在的宿主机 Node 2 的地址。每台宿主机上的 flanneld，都监听着一个 8285 端口，所以 flanneld 只要把 UDP 包发往 Node 2 的 8285 端口即可。
6. UDP 包就从 Node 1 到达了 Node 2。而 Node 2 上监听 8285 端口的进程也是 flanneld，所以这时候，Node2上的 flanneld 就可以从这个 UDP 包里 解析出封装在里面的、container-1 发来的原 IP 包。
7. flanneld 会直接把这个 IP 包发送给它所管理的 TUN 设 备，即 flannel0 设备。根据我前面讲解的 TUN 设备的原理，这正是一个从用户态向内核态的流动方向（Flannel 进程向 TUN 设备发送数据包），所以 Linux 内核网络栈就会负责处理这个 IP 包.
8. 具体的处理方法，就是通过本机的路由表来寻找这个 IP 包的下一步流向。
```
# 在 Node 2 上
$ ip route
default via 10.168.0.1 dev eth0
100.96.0.0/16 dev flannel0  proto kernel  scope link  src
100.96.2.0 100.96.2.0/24 dev docker0  proto kernel  scope link  src 100.96.2.1
10.168.0.0/24 dev eth0  proto kernel  scope link  src 10.168.0.3
```
9. IP 包的目的地址是 100.96.2.3，它跟第三条、也就是 100.96.2.0/24 网段对应的路由规 则匹配更加精确。所以，Linux 内核就会按照这条路由规则，把这个 IP 包转发给 docker0 网桥。
10. docker0 网桥会扮演二层交换机的角色，将数据包发送给正确的端口，进而通过 Veth Pair 设备进入到 container-2 的 Network Namespace 里。

UDP模式下的封包格式：

![](/images/k8s-network-1/14.png)

- 数据包分两部分，内部数据包（inner）和外部数据包（outer）
- inner数据包中的IP Header存放的是container1和container2的ip地址
- outer数据包中的IP Header存放的是container所在的宿主机的IP地址
- outer数据包中的Ethernet Header 存放的是对应的宿主机的 MAC地址
- 通过flanneld进程实现了对数据包的二次封装，container2 ip —> container所在子网–> * container 所在宿主机的ip地址(通过etcd得到相关信息)

数据包的封装和拆解，依靠的是Flannel进程，而将数据包从内核转移到用户空间，则需要tun设备的支持，也就是flannel0设备。UDP模式存在的问题就是巨大的资源浪费和消耗。

UDP模式存在着严重的性能问题，其性能问题主要在于用户态和内核态之间的数据拷贝，如下图所示：

![](/images/k8s-network-1/15.png)

性能代价

- 第一次：用户态的容器进程发出的 IP 包经过 docker0 网桥进入内核态；
- 第二次：IP 包根据路由表进入 TUN（flannel0）设备，从而回到用户态的 flanneld 进程；
- 第三次：flanneld 进行 UDP 封包之后重新进入内核态，将 UDP 包通过宿主机的 eth0 发出去

此外，Flannel 进行 UDP 封装（Encapsulation）和解封装（Decapsulation） 的过程，也都是在用户态完成的。在 Linux 操作系统中，上述这些上下文切换和用户态操作的代价 其实是比较高的，这也正是造成 Flannel UDP 模式性能不好的主要原因。

#### VXLAN

名词解释

> VXLAN：即 Virtual Extensible LAN（虚拟可扩展局域网），是 Linux 内核本身就支持的一种网络 虚似化技术。所以说，VXLAN 可以完全在内核态实现上述封装和解封装的工作，从而通过与前面相似的“隧道”机制，构建出覆盖网络（Overlay Network）。VXLAN 的覆盖网络的设计思想是：在现有的三层网络之上，“覆盖”一层虚拟的、由内核 VXLAN 模块负责维护的二层网络，使得连接在这个 VXLAN 二层网络上的“主机”（虚拟机或者容器都可 以）之间，可以像在同一个局域网（LAN）里那样自由通信。当然，实际上，这些“主机”可能分布在不同的宿主机上，甚至是分布在不同的物理机房里。
> VTEP：为了能够在二层网络上打通“隧道”，VXLAN 会在宿主机上设置一个特殊的网络设备作为“隧道”的两端。这个设备就叫作 VTEP，即：VXLAN Tunnel End Point（虚拟隧道端点）。flannel.1就是VTEP设备。而 VTEP 设备的作用，其实跟前面的 flanneld 进程非常相似。只不过，它进行封装和解封装的对象，是二层数据帧（Ethernet frame）；而且这个工作的执行流程，全部是在内核里完成的（因为VXLAN 本身就是 Linux 内核中的一个模块）。

![](/images/k8s-network-1/16.png)

在VXLAN模式下，容器之间通信的过程如上图所示：

1. container1通过veth pair方式连接到node1中的cni0网桥上，将数据包传输给cni0（网桥设备），类似于上文所述的docker0。
2. 数据包通过cni0网桥到达宿主机，此时宿主机的路由表如下所示，根据路由匹配规则，数据包将会交由flannel.1设备（VTEP设备）处理。
```
# route -n
Kernel IP routing table
Destination     Gateway         Genmask         Flags Metric Ref    Use Iface
...
10.244.0.0      0.0.0.0         255.255.255.0   U     0      0        0 cni0
10.244.1.0      10.244.1.0      255.255.255.0   UG    0      0        0 flannel.1
10.244.2.0      10.244.2.0      255.255.255.0   UG    0      0        0 flannel.1
172.17.0.0      0.0.0.0         255.255.0.0     U     0      0        0 docker0
```
3. node1上的flannel.1设备作为源VTEP设备，node2上的flannel.1设备作为目的VTEP设备。“源 VTEP 设备”收到“原始 IP 包”后，把“原始 IP 包”加上 一个目的 MAC 地址（目的VTEP设备的MAC地址），封装成一个二层数据帧，准备发送给“目的 VTEP 设备”。
4. 目的mac地址可以通过arp记录查询，该条arp记录是node2节点启动flanneld进程时产生的。通过如下命令可以查看得到。
```
# ip neigh show dev flannel.1
10.244.1.0 lladdr 42:40:c7:4c:be:19 PERMANENT
10.244.2.0 lladdr 76:c5:dd:8c:d9:a9 PERMANENT
```
5. 对ip包，进行二层封装，封装为MAC帧，如下所示。Inner Ethernet Header为node2上的VETH设备，flannel.1的mac地址（42:40:c7:4c:be:19）。上述封包过程只是加一个二层头，不会改变“原始 IP 包”的内容。所以图中的 Inner IP Header 字段为目的容器的IP地址（10.244.1.3）。
![](/images/k8s-network-1/17.png)
通过以上步骤得到的MAC帧，并不能够直接在网络中传输，因此需要把内部数据帧进一步封装成为宿主机网络里的普通数据帧，通过宿主机网络进行传输。要封装出来的、宿主机对应的数据帧称为“外部数据帧”（Outer Ethernet Frame）
6. 封装VXLAN头部。Linux 内核会在“内部数据帧”前面，加上一个特殊的 VXLAN 头，用来表示这个“乘客”实际上是一个 VXLAN 要使用的数据帧。而这个 VXLAN 头里有一个重要的标志叫作VNI，它是 VTEP 设备识别某个数据帧是不是应该归自 己处理的重要标识。而在 Flannel 中，VNI 的默认值是 1，这也是为何，宿主机上的 VTEP 设备都 叫作 flannel.1 的原因，这里的“1”，其实就是 VNI 的值。
7. 封装UDP头部。flannel.1 设备实际上要扮演一个“网桥”的角色，在二层网络进行 UDP 包的转 发。而在 Linux 内核里面，“网桥”设备进行转发的依据，来自于一个叫作 FDB（Forwarding Database）的转发数据库。不难想到，这个 flannel.1“网桥”对应的 FDB 信息，也是 flanneld 进程负责维护的。它的内容可以通过 bridge fdb 命令查看到，如下所示：
```
# bridge fdb show |grep 42:40:c7:4c:be:19
42:40:c7:4c:be:19 dev flannel.1 dst 10.1.18.108 self permanent
```
8. UDP 包是一个四层数据包，所以 Linux 内核会在它前面加上一个 IP 头，即原理图中的 Outer IP Header，组成一个 IP 包。并且，在这个 IP 头里，会填上前面通过 FDB 查询出来的目的 主机的 IP 地址，即 Node 2 的 IP 地址 10.1.18.108。
9. Linux 内核再在这个 IP 包前面加上二层数据帧头，即Outer Ethernet Header， 并把 Node 2 的 MAC 地址填进去。整个包结构如下所示。
![](/images/k8s-network-1/18.png)
10. Node 1 上的 flannel.1 设备就可以把这个数据帧从 Node 1 的 eth0 网卡发出去。显然， 这个帧会经过宿主机网络来到 Node 2 的 eth0 网卡。
11. Node 2 的内核网络栈会发现这个数据帧里有 VXLAN Header，并且 VNI=1。所以 Linux 内核会对它进行拆包，拿到里面的内部数据帧，然后根据 VNI 的值，把它交给 Node 2 上的 flannel.1 设备。
12. 而 flannel.1 设备检查数据包的目的mac地址是否为自己的mac地址，若是，则会进一步拆包，取出“原始 IP 包”。该包的目的IP地址是（10.244.1.3），是一条直连路由,将通过路由表转发到cni0上。路由信息如下。
```
# route -n
Kernel IP routing table
Destination     Gateway         Genmask         Flags Metric Ref    Use Iface
...
10.244.1.0      0.0.0.0         255.255.255.0   U     0      0        0 cni0
10.244.2.0      10.244.2.0      255.255.255.0   UG    0      0        0 flannel.1
172.17.0.0      0.0.0.0         255.255.0.0     U     0      0        0 docker0
...
```
13. 数据包到达cni0网桥，然后转发到对应的Veth Pair设备，最后出现在对应的容器中。VXLAN模式下的封包格式如下所示：

![](/images/k8s-network-1/19.png)

对各个字段解释如下：

- 整个数据包分为两部分，一部分是Inner数据包，一部分是outer数据包。inner数据包是逻辑上的overlay网咯，而outer数据包才是真实的物理网络。
- inner部分的IP Header为container1和container2的IP地址。而Ethernet Header里面存放的是container所在的宿主机上的vtep设备的地址。也就是两台宿主机上的flannel.1设备的mac地址。
- VXLAN 头里有一个重要的标志叫作VNI，它是 VTEP 设备识别某个数据帧是不是应该归自 己处理的重要标识。而在 Flannel 中，VNI 的默认值是 1，这也是为何，宿主机上的 VTEP 设备都 叫作 flannel.1 的原因，这里的“1”，其实就是 VNI 的值。
- outer数据帧的IP Header字段，存放了宿主机的IP地址，而Ethernet Header字段存放了宿主机的真实mac地址。
- 通过flannel.1设备（VETP设备）实现了对数据包的二次封装，

**上述报文的封装和拆解工作，实际上是依靠内核机制，也就是VTEP设备实现的。**

Flannel是跨节点容器网络方案之一，它提供的Overlay方案主要有两种方式，一种是UDP在用户态封装，一种是VXLAN在内核态封装，而VXLAN的性能更好一些。这两种模式都可以称作隧道机制。

#### host-gw

host-gw的工作原理就是将每个flannel子网转发地址设置成了该子网对应的宿主机的IP地址，通过这个过程，容器在通信过程中就减少了封包和解包的性能损耗。如下图所示：

![](/images/k8s-network-1/20.png)

1. container-1发送目的ip地址为10.244.1.3的数据包，根据container-1上的路由信息，通过veth-pair设备到达cni0网桥，此时数据包到达宿主机。
2. 在使用了Flannel的host-gw模式之后，flanneld进程会为宿主机增加一条路由，路由信息如下。
```
$ ip route
10.244.1.0/24 via 10.168.0.3 dev eth0
```
其含义是，目的 IP 地址属于 10.244.1.0/24 网段的 IP 包，应该经过本机的 eth0 设备发出去（即：dev eth0）；并且，它下一跳地址（next-hop）是 10.168.0.3（也就是目的宿主机Node2的ip地址）
3. 配置了下一跳地址之后，当 IP 包从网络层进入链路层封装成帧的时候，eth0 设备 就会使用下一跳地址对应的 MAC 地址，作为该数据帧的目的 MAC 地址。显然，这个 MAC 地 址，正是 Node 2 的 MAC 地址。
4. 数据帧就会从 Node 1 通过宿主机的二层网络顺利到达 Node 2 上。
5. Node 2 的内核网络栈从二层数据帧里拿到 IP 包后，会“看到”这个 IP 包的目的 IP 地址是 10.244.1.3，即 Infra-container-2 的 IP 地址。这时候，根据 Node 2 上的路由表，该目的地址会匹配到图中的第二条路由规则（也就是 10.244.1.0 对应的路由规则），从而进入 cni0 网桥，由于这是条直连路由，故而可以直接得到mac地址，通过veth pair设备进入到 Infra-container-2 当中。进而 进入到 Infra-container-2 当中。

以上就是host-gw模式的通信原理。其核心就是将每个 Flannel 子网（Flannel Subnet，比 如：10.244.1.0/24）的“下一跳”，设置成了该子网对应的宿主机的 IP 地址。也就是说，这台“主机”（Host）会充当这条容器通信路径里的“网关”（Gateway）。这也 正是“host-gw”的含义。

当然，Flannel 子网和主机的信息，都是保存在 Etcd 当中的。flanneld 只需要 WACTH 这些数 据的变化，然后实时更新路由表即可。

host-gw 模式能够正常工作的核心，就在于 IP 包在封 装成帧发送出去的时候，会使用路由表里的“下一跳”来设置目的 MAC 地址。这样，它就会经 过二层网络到达目的宿主机。这就要求集群宿主机之间必须要二层连通的。

性能最好，但有致命缺陷,无法跨物理二次子网。

## k8s ingress 网络

网络链路从外到里是: ingress --> service --> pod

pod 与 pod 之间通过上述的网络方案解决了，每个 pod 都有一个唯一ip，而 pod 是可以缩扩容，并且无状态的，意味随时销毁新建，那么ip 就是动态变化的。那么pod 与 pod 之间直接 IP 通信就不现实，需要使用 service, pod ip 不停变化，service 域名是固定的，service 也能提供服务发现，负载均衡

### service

Kubernetes Service 定义了这样一种抽象：一个 Pod 的逻辑分组，一种可以访问到它们的策略 -- 通常成为微服务。这一组 Pod 能够被 Service 访问到

service 工作方式有三种: Userspace、iptables、ipvs

### userspace

如下图描述, Client Pod要访问Server Pod时,它先将请求发给本机内核空间中的service规则，由它再将请求,转给监听在指定套接字上的kube-proxy，kube-proxy处理完请求，并分发请求到指定Server Pod后,再将请求递交给内核空间中的service,由service将请求转给指定的Server Pod。

![](/images/k8s-network-1/21.png)

由于其需要来回在用户空间和内核空间交互通信，因此效率很差，已经废弃，接着就有了第二种方式.

### iptables模型

此工作方式是直接由内核中的iptables规则，接受Client Pod的请求，并处理完成后，直接转发给指定ServerPod.

![](/images/k8s-network-1/22.png)

该方式有个缺陷每一个 pod 就是一个 iptables 连规则，每台 node 都要执行，当大于 5K 规则时，每变更一条性能急剧下降。

### ipvs模型

它是直接有内核中的ipvs规则来接受Client Pod请求，并处理该请求,再有内核封包后，直接发给指定的Server Pod。

![](/images/k8s-network-1/23.png)

以上不论哪种，kube-proxy都通过watch的方式监控着kube-APIServer写入etcd中关于Pod的最新状态信息,它一旦检查到一个Pod资源被删除了 或 新建，它将立即将这些变化，反应再iptables 或 ipvs规则中，以便iptables和ipvs在调度Clinet Pod请求到Server Pod时，不会出现Server Pod不存在的情况。

### ingress

service 解决了 pod 的服务发现和负载均衡，但目前都还是在集群内部玩，而集群外部网络如何进来？

原理就是每台 node 上部署一个 "nginx" 做七层代理，比如 13.25 配置了一台node ip,反向的时候带上了 host 域名，这个请求到达 ingress 应用程序内部，会转发到 service,service 转发到 pod。

结语: 万丈高楼平地起, k8s 网络的底层由这一系列技术支撑,k8s 早期亲自下海做网络,如今只做标准，实现交给各个产商。而各个产商的技术也是各领风骚一段时间,随着时间的发展,个人认为比较火的一个技术eBPF加持会让 K8s 网络更加高效。

---

*本文首发于公众号「算法 SRE」，[原文链接](https://mp.weixin.qq.com/s/gtz87puW4TBFNwRmpvHmHw)。*
