---
title: "Kubernetes Networking, Part 1"
description: "An introduction to Kubernetes networking: Docker networking built from namespaces, veth, bridges, iptables and routing, then Flannel's UDP, VXLAN and host-gw modes and the Service proxy models."
pubDate: 2022-03-24
tags: ["Kubernetes", "Networking"]
---

> A casual introduction to Kubernetes networking, part 1: Docker networking, Kubernetes networking, Flannel, and ingress.

## Docker networking

Docker builds on recent advances in Linux kernel virtualization, so it depends heavily on kernel features. The main Linux networking technologies Docker uses are:

- Linux network namespaces
- Veth (virtual Ethernet device pairs)
- Bridges
- Iptables/Netfilter (usually used as a firewall)
- Routing

### Network Namespace

A network namespace isolates network resources: network devices, the IPv4 and IPv6 protocol stacks, IP routing tables, firewalls, the /proc/net and /sys/class/net directories, sockets and so on. With this isolation, one host can run many separate virtual network environments. Network stacks in different namespaces are completely isolated and cannot talk to each other, like two "parallel universes". Docker uses network namespaces to isolate the networks of different containers.

- Linux introduced network namespaces into the network stack to support multiple instances of the protocol stack; stacks in different namespaces are completely isolated
- A Linux network namespace can have its own routing table and its own Iptables/Netfilter settings for forwarding, NAT and IP packet filtering
- Things that belong to a namespace include processes, sockets and network devices

Step 1. Let's try network namespaces on a Linux host (192.168.1.100). `ip netns` is the command for managing network namespaces:

```bash
# Create a namespace named bruce
$ ip netns add bruce
# List the network namespaces on the system
$ ip netns list
bruce
# Show bruce's network interfaces
$ ip netns exec bruce ip addr
# Create another network namespace named dog
$ ip netns add dog
```

### Veth pairs

Step 2. Use a veth pair so that bruce and dog can talk to each other.

```bash
# Create a veth pair
$ ip link add veth_bruce type veth peer name veth_dog      
# Move veth_bruce into the bruce network namespace
$ ip link set veth_bruce netns bruce
# Move veth_dog into the dog network namespace
$ ip link set veth_dog netns dog

# Verify
$ ip netns exec bruce ip link
$ ip netns exec dog ip link

# Bring up the lo interfaces in bruce and dog
$ip netns exec bruce ip link set dev lo up
$ip netns exec dog ip link set dev lo up

# Assign an IP to veth_bruce in bruce and bring it up
$ ip netns exec bruce ip addr add 10.0.0.1/24 dev veth_bruce
$ ip netns exec bruce ip link set dev veth_bruce up

# Assign an IP to veth_dog in dog and bring it up
$ ip netns exec dog ip addr add 10.0.0.2/24 dev veth_dog
$ ip netns exec dog ip link set dev veth_dog up

# Show the ip routes in bruce and dog
$ ip netns exec bruce ip route
10.0.0.0/24 dev veth_bruce protokernel scope link src 10.0.0.1
$ip netns exec dog ip route
10.0.0.0/24 dev veth_dog proto kernel scope link src 10.0.0.2
```

These two routes mean that IP packets destined for the 10.0.0.0/24 network go out through veth_bruce and veth_dog respectively.

Step 3. bruce and dog now each have their own interface, IP address and routing table; each is effectively a small "virtual machine". Let's test connectivity between them:

```
$ip netns exec bruce pint 10.0.0.2
64 bytes from 10.0.0.2:icmp_seq = 1 ttl=64 time=0.088
$ip netns exec dog pint 10.0.0.1
64 bytes from 10.0.0.1:icmp_seq = 1 ttl=64 time=0.088
```

We have now built this setup: two separate network namespaces talking through a veth pair. The architecture:

![](/images/k8s-network-1/1.png)

### Bridges

Now suppose we create a third network namespace: how do all three talk to each other? Once you need to connect more than two network namespaces, you need a switch, and Linux provides a bridge for this. As shown:

![](/images/k8s-network-1/2.png)

```sql
# Add 2 namespaces
ip netns add ns1
ip netns add ns2

# Create a bridge named br-test and bring it up
brctl addbr br-test
brctl stp br-test off
ip link set dev br-test up

### PORT 1
# Create a port pair
ip link add tap1 type veth peer name br-tap1
# Attach one end to the Linux bridge
brctl addif br-test br-tap1
# Attach the other end to the ns1 namespace
ip link set tap1 netns ns1
# Bring the ports up
ip link set dev br-tap1 up
ip netns exec ns1 ip link set dev tap1 up
ip link set dev br-tap1 up

### PORT 2: same as above
ip link add tap2 type veth peer name br-tap2
brctl addif br-test br-tap2
ip link set tap2 netns ns2
ip netns exec ns2 ip link set dev tap2 up
ip link set dev br-tap2 up

# Bring up lo in ns1 and ns2
ip netns exec ns1 ip link set dev lo up
ip netns exec ns2 ip link set dev lo up

# Configure the br-test bridge
ifconfig br-test 10.0.0.0/24
# Assign IP addresses to the interfaces in the namespaces
ip netns exec ns1 ip addr add 10.0.0.1/24 dev tap1
ip netns exec ns2 ip addr add 10.0.0.2/24 dev tap2

# Test
ip netns exec ns1 ping 10.0.0.2
ip netns exec ns2 ping 10.0.0.1
```

With network namespaces, veth pairs and a bridge, we have created isolated network environments that can reach each other, which is also how Docker's default network mode works. But our network namespaces can't reach the outside world, and the outside world can't reach them, whereas Docker containers can reach the host and the outside world and accept connections from outside. All of that is handled by Iptables/Netfilter.

### Iptables/Netfilter

Netfilter is a packet-processing module inside the Linux kernel. It provides:

- Network address translation (NAT)
- Packet mangling
- Packet filtering, i.e. firewalling
- ...

Netfilter defines five hook points for packets (think of them as callbacks: when a packet reaches one of these points, our functions are invoked, giving us a chance to change its route or content as it is routed). The five hook points are PREROUTING, INPUT, OUTPUT, FORWARD and POSTROUTING.

![](/images/k8s-network-1/3.png)

Netfilter's rules live in kernel memory, while iptables is a user-space program that uses the interface Netfilter exposes to modify these tables (Netfilter's configuration). They are made up of tables, chains and rules, and iptables is responsible for editing them from user space.

![](/images/k8s-network-1/4.png)

The rules attached to these hook points come in different types. The supported tables are:

- FILTER
Mainly filters packets, deciding whether to let each one through according to the rules (e.g. DROP, ACCEPT, REJECT, LOG). The filter table is implemented by the iptable_filter kernel module and has three chains:
- NAT
Mainly rewrites packet IP addresses, ports and so on (network address translation, e.g. SNAT, DNAT, MASQUERADE, REDIRECT). Packets belonging to one flow (data may be split into several packets because of size limits) pass through this table only once: if the first packet is NATed or masqueraded, the rest automatically get the same treatment and don't go through the table again. It is implemented by the iptable_nat kernel module and has three chains:
- MANGLE
Mainly modifies a packet's TOS (type of service) and TTL (time to live), and sets marks on packets for QoS (quality of service) tuning, policy routing and similar uses. Since it requires support from routing devices, it is not widely used. It has five chains: PREROUTING, POSTROUTING, INPUT, OUTPUT and FORWARD.
- RAW
Mainly decides whether a packet is handled by connection tracking. When matching packets, raw table rules take precedence over the other tables. It has two chains: OUTPUT and PREROUTING.

iptables has five built-in chains. Seen from when they apply:

- INPUT: applied when a packet addressed to the firewall host itself arrives (inbound).
- OUTPUT: applied when the firewall host sends a packet out (outbound).
- FORWARD: applied when a packet arrives that must be sent on to another address through the firewall (forwarding).
- PREROUTING: applied before the routing decision, e.g. DNAT.
- POSTROUTING: applied after the routing decision, e.g. SNAT.

![](/images/k8s-network-1/5.png)

**Iptables/Netfilter summary**

Iptables is the user-space program that drives the kernel's Netfilter to control packets entering the host through its network interfaces. Common uses include closing ports, opening ports, NAT forwarding and so on. Next up: routing.

- PREROUTING chain: changes a packet's destination address as soon as it reaches the firewall
- OUTPUT chain: changes the destination address of locally generated packets
- POSTROUTING chain: changes a packet's source address just before it leaves the firewall

### Routing

Linux has full routing built in. When the IP layer sends or forwards data, it uses the routing table to decide where it goes. To view it:

```bash
$ ip route list
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
```

This route says that all packets destined for 172.17.0.0/16 go out through the docker0 interface.

### Docker bridge networking in detail

Above, using network namespaces, veth pairs and a bridge, we built isolated network spaces that can talk to each other. Network namespaces, veth pairs, bridges, Iptables/Netfilter and routing are exactly the kernel technologies Docker's default network uses.

Docker bridge architecture:

![](/images/k8s-network-1/6.png)

Bridge mode gives Docker containers connectivity to the host and to other machines. However, eth0, docker0 and the veth pair are not on the same subnet, so namespaces, veth and bridges alone are not enough for networks outside the host to discover a container. To let the world outside the host reach the services a container exposes, Docker uses NAT (network address translation), so that the outside world can send packets into the container. In other words, it operates on the Iptables/Netfilter described above. As shown below, the key part is NAT.

![](/images/k8s-network-1/7.png)

### Reaching a container from outside

When the world outside the host needs to reach a container, packets flow like this:

![](/images/k8s-network-1/8.png)

Since the container's IP and port are invisible from outside, packets are addressed to the host's IP and port. The router sends the packet to the host's eth0, which forwards it to the docker0 bridge. A DNAT rule rewrites the destination to the container's IP and port, 172.17.0.n:24. The docker0 bridge recognizes the container's IP and port and sends the packet to the veth0 interface attached to docker0, which passes it to the veth1 interface inside the container. The container receives the packet and responds.

![](/images/k8s-network-1/9.png)

### Reaching the outside from a container

When a container needs to reach the world outside the host, packets flow like this:

![](/images/k8s-network-1/10.png)

Here the packet's source address is the container's IP and port, 172.17.0.n:24. The veth1 interface inside the container sends the packet to veth0, and it reaches the docker0 bridge. docker0 sees that the destination is an external IP and port, so it forwards the packet to eth0, which sends it out. An SNAT rule rewrites the source address to the host's IP and port.

Since the router knows the host's IP, it forwards the packet to the outside world, which receives it and responds. From the outside, the packet appears to come from the physical machine's NIC; the Docker container is invisible.

![](/images/k8s-network-1/11.png)

### Summary: how containers on a Docker bridge talk to the outside world

As shown above, the key to traffic in and out of containers is DNAT and SNAT, i.e. NAT (network address translation), and it is implemented with iptables.

```
$ iptables-save # check the POSTROUTING chain in the nat table, which contains this rule
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
```

This rule applies source NAT (SNAT) to packets with source addresses in 172.17.0.0/16 (i.e. packets from Docker containers) that are not going out through docker0, rewriting the source to the host interface's address. This is the core mechanism that lets containers reach external networks.

Reaching a container from outside also relies on address translation. First, start a web container with port 8080 mapped:

```
docker run -d --name web -p 2376:80 fmzhen/simpleweb
```

Then the iptables rules will include, under *nat:

```
-A DOCKER ! -i docker0 -p tcp -m tcp --dport 2376 -j DNAT --to-destination 172.17.0.8:80
```

This rule applies DNAT to TCP traffic arriving at the host's eth0 on port 2376 and sends it to 172.17.0.8:80. So from outside we just need to access eth0's IP on port 2376 to be forwarded into the container.

### Docker networking summary

Docker's network model uses bridge mode by default, and we've traced how it is implemented in detail: Linux network namespaces create isolated network spaces; veth pairs connect those spaces to the host; a bridge lets multiple namespaces talk to each other; and iptables connects namespaces to the outside world.

```
$ ip route list
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
```

This route says that all packets destined for 172.17.0.0/16 go out through the docker0 interface.

## Kubernetes networking

Kubernetes networking has to achieve several goals:

1. Containers can talk to containers
2. Pods can talk to pods
3. Pods can talk to Services
4. Services can talk to the outside world

Docker's default bridge network, by contrast, has two drawbacks: containers can't talk across hosts directly and must go through NAT port forwarding on the host, and NAT port forwarding is hard to manage with many hosts and many ports. So Kubernetes sets a few requirements for networking, without implementing them itself:

1. All containers can talk to all other containers without NAT.
2. All nodes can talk to all containers (and vice versa) without NAT.
3. Every container has a unique IP.

Kubernetes defines the requirements and a specification, CNI (Container Network Interface), and other technologies implement it as plugins.

### CNI (Container Network Interface)

The Container Network Interface (CNI) is a container networking specification originally launched by CoreOS, and it is the foundation of Kubernetes network plugins. The basic idea: when the container runtime creates a container, it first creates the network namespace, then calls a CNI plugin to configure networking for that netns, and only then starts the processes in the container.

All other containers in a Kubernetes pod share the network of the pod's pause container. The creation process is:

1. The kubelet creates the pause container, which creates the network namespace, then calls the CNI driver
2. The CNI driver calls the specific CNI plugin according to its configuration
3. The CNI plugin configures networking for the pause container
4. The other containers in the pod all use the pause container's network

![](/images/k8s-network-1/12.png)

Put simply, Kubernetes' network model sets the requirements and exposes an interface through plugins that anyone can implement.

### Flannel

Flannel is a network fabric designed for Kubernetes by the CoreOS team. In short, it gives Docker containers created on different nodes of the cluster virtual IP addresses that are unique across the whole cluster.

With the default Docker configuration, the Docker daemon on each node assigns IPs to the containers on that node independently. As a result, containers on different nodes may get the same IP address, and they can't find each other by IP, i.e. can't ping each other.

Flannel is designed to re-plan IP address allocation for all nodes in the cluster, so that containers on different nodes get IP addresses that are on the same internal network and don't collide, and containers on different nodes can talk directly over those internal IPs.

Flannel is essentially an overlay network: it wraps TCP packets inside another kind of network packet for routing and forwarding. It supports udp, vxlan, host-gw, aws-vpc, gce, alloc and other backends; the default for traffic between nodes is UDP.

Features:

1. Docker containers created on different nodes in the cluster get virtual IPs that are unique across the cluster.
2. It builds an overlay network through which packets are delivered unchanged to the target container. An overlay network is a virtual network built on top of another network and supported by its infrastructure. It decouples network services from the underlying infrastructure by encapsulating one packet inside another, and decapsulates the packet once it reaches its endpoint.
3. It creates a new virtual interface, flannel0, which receives data from the Docker bridge and, by maintaining a routing table, encapsulates and forwards it (vxlan).
4. etcd ensures the configuration seen by flanneld on every node is consistent, and flanneld on each node watches etcd for changes, so it learns about node changes in the cluster in real time.

#### UDP

![](/images/k8s-network-1/13.png)

When container 100.96.1.2/24 wants to talk to container 100.96.2.3/24:

1. An IP packet sent by a process in container-1 has source address 100.96.1.2 and destination 100.96.2.3. Since 100.96.2.3 is not in the subnet of Node 1's docker0 bridge, the packet follows container-1's default route and enters docker0 through the container's gateway (traffic between containers on the same host uses the direct route instead), and thus appears on the host.
2. The routing rules on the host are shown below. The destination 100.96.2.3 doesn't match the 100.96.1.0/24 subnet of the local docker0 bridge; it can only match the second rule, for 100.96.0.0/16, so the packet enters a device called flannel0.

```
$ ip route
default via 10.168.0.1 dev eth0
100.96.0.0/16 dev flannel0  proto kernel  scope link  src 100.96.1.0
100.96.1.0/24 dev docker0  proto kernel  scope link  src 100.96.1.1
10.168.0.0/24 dev eth0  proto kernel  scope link  src 10.168.0.2
```

3. When the OS sends an IP packet to the flannel0 device, flannel0 hands it to the application that created the device, the Flannel process. This is a flow from kernel space (the Linux OS) to user space (the Flannel process). (Note that flannel0 is a TUN device, a virtual network device that works at layer 3, while flanneld is a proxy that listens on flannel0 and forwards traffic.)
4. When flanneld processes the IP packet from flannel0, it uses the packet's destination IP (e.g. 100.96.2.3) to find the matching subnet (e.g. 100.96.2.0/24), and looks up in etcd that the host for this subnet has IP 10.168.0.3, as shown below:

```
$ etcdctl get /coreos.com/network/subnets/100.96.2.0-24
{"PublicIP":"10.168.0.3"}
$ etcdctl ls /coreos.com/network/subnets
/coreos.com/network/subnets/100.96.1.0-24
/coreos.com/network/subnets/100.96.2.0-24
/coreos.com/network/subnets/100.96.3.0-24
```

5. The flannel process encapsulates the IP packet again, directly inside a UDP packet, and sends it to Node 2. The UDP packet's source address is Node 1, where this flanneld runs, and its destination is Node 2, the host of container-2. flanneld on every host listens on port 8285, so it just sends the UDP packet to port 8285 on Node 2.
6. The UDP packet travels from Node 1 to Node 2. The process listening on port 8285 on Node 2 is also flanneld, so flanneld on Node 2 can unpack the original IP packet sent by container-1 from the UDP packet.
7. flanneld sends this IP packet straight to the TUN device it manages, flannel0. Following how TUN devices work, as explained earlier, this is a flow from user space to kernel space (the Flannel process sending a packet to the TUN device), so the Linux kernel network stack takes over the packet.
8. Concretely, it looks up the next hop for the packet in the local routing table.

```
# On Node 2
$ ip route
default via 10.168.0.1 dev eth0
100.96.0.0/16 dev flannel0  proto kernel  scope link  src
100.96.2.0 100.96.2.0/24 dev docker0  proto kernel  scope link  src 100.96.2.1
10.168.0.0/24 dev eth0  proto kernel  scope link  src 10.168.0.3
```

9. The destination 100.96.2.3 matches the third rule, for 100.96.2.0/24, more precisely, so the kernel follows that rule and forwards the packet to the docker0 bridge.
10. docker0 acts as a layer-2 switch, sending the packet to the right port, and through the veth pair it enters container-2's network namespace.

Packet format in UDP mode:

![](/images/k8s-network-1/14.png)

- The packet has two parts: the inner packet and the outer packet
- The IP header of the inner packet holds the IP addresses of container1 and container2
- The IP header of the outer packet holds the IP addresses of the hosts the containers run on
- The Ethernet header of the outer packet holds the MAC addresses of those hosts
- The flanneld process performs the second encapsulation: container2 IP → container's subnet → IP of the container's host (looked up in etcd)

Encapsulation and decapsulation are done by the Flannel process, and moving packets from the kernel to user space requires a TUN device, flannel0. The problem with UDP mode is the huge waste of resources.

UDP mode has serious performance problems, mainly from copying data between user space and kernel space, as shown below:

![](/images/k8s-network-1/15.png)

**The performance cost**

- First copy: the IP packet sent by the container process in user space enters kernel space through the docker0 bridge;
- Second copy: following the routing table, the packet enters the TUN device (flannel0) and goes back up to the flanneld process in user space;
- Third copy: after UDP encapsulation, flanneld sends it back into kernel space, and the UDP packet goes out through the host's eth0

On top of that, Flannel's UDP encapsulation and decapsulation both happen in user space. On Linux, these context switches and user-space operations are fairly expensive, which is the main reason Flannel's UDP mode performs poorly.

#### VXLAN

**Glossary**

> VXLAN: Virtual Extensible LAN, a network virtualization technology supported natively by the Linux kernel. VXLAN can do all the encapsulation and decapsulation described above entirely in kernel space, building an overlay network with a similar "tunnel" mechanism. The idea behind a VXLAN overlay is to lay a virtual layer-2 network, maintained by the kernel's VXLAN module, on top of the existing layer-3 network, so that "hosts" (VMs or containers) attached to this VXLAN layer-2 network can talk freely as if they were on the same LAN, even though they may actually be spread across different hosts or even different data centers.
> VTEP: to open a "tunnel" over the layer-2 network, VXLAN sets up a special network device on each host as an end of the tunnel. This device is called a VTEP, VXLAN Tunnel End Point. flannel.1 is a VTEP device. A VTEP does much the same job as the flanneld process above, except that it encapsulates and decapsulates layer-2 Ethernet frames, and the whole process runs inside the kernel (VXLAN itself is a Linux kernel module).

![](/images/k8s-network-1/16.png)

In VXLAN mode, containers communicate as shown in the figure above:

1. container1 is connected to the cni0 bridge on node1 through a veth pair and sends the packet to cni0 (a bridge device), similar to docker0 described earlier.
2. The packet reaches the host through cni0. The host's routing table is shown below; according to the routing rules, the packet is handed to the flannel.1 device (the VTEP).

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

3. flannel.1 on node1 is the source VTEP and flannel.1 on node2 is the destination VTEP. When the source VTEP receives the original IP packet, it adds a destination MAC address (the MAC of the destination VTEP) and wraps it into a layer-2 frame to send to the destination VTEP.
4. The destination MAC can be found in an ARP entry, created when flanneld started on node2. It can be seen with the following command.

```
# ip neigh show dev flannel.1
10.244.1.0 lladdr 42:40:c7:4c:be:19 PERMANENT
10.244.2.0 lladdr 76:c5:dd:8c:d9:a9 PERMANENT
```

5. The IP packet is encapsulated at layer 2 into a MAC frame, as shown below. The inner Ethernet header holds the MAC address of the VTEP device on node2, flannel.1 (42:40:c7:4c:be:19). This only adds a layer-2 header and doesn't change the original IP packet, so the Inner IP Header in the figure holds the destination container's IP (10.244.1.3).
![](/images/k8s-network-1/17.png)
The MAC frame produced so far can't travel on the network directly, so the inner frame has to be wrapped further into an ordinary frame on the host network and sent over it. This host-level frame is called the outer Ethernet frame.
6. Add the VXLAN header. The Linux kernel prepends a special VXLAN header to the inner frame to mark this "passenger" as a frame for VXLAN. The VXLAN header has an important field called the VNI, which a VTEP uses to decide whether a frame is meant for it. In Flannel the VNI defaults to 1, which is why the VTEP devices on the hosts are all called flannel.1: the "1" is the VNI.
7. Add the UDP header. flannel.1 effectively acts as a "bridge", forwarding UDP packets over the layer-2 network. In the Linux kernel, a bridge forwards based on a forwarding database called the FDB. Unsurprisingly, the FDB entries for the flannel.1 "bridge" are also maintained by flanneld. You can see them with the bridge fdb command:

```
# bridge fdb show |grep 42:40:c7:4c:be:19
42:40:c7:4c:be:19 dev flannel.1 dst 10.1.18.108 self permanent
```

8. A UDP packet is a layer-4 packet, so the Linux kernel prepends an IP header (the Outer IP Header in the diagram) to form an IP packet, filling in the destination host's IP found in the FDB, i.e. Node 2's IP, 10.1.18.108.
9. The kernel then prepends a layer-2 frame header, the Outer Ethernet Header, with Node 2's MAC address. The full packet structure is shown below.
![](/images/k8s-network-1/18.png)
10. flannel.1 on Node 1 can now send this frame out of Node 1's eth0. The frame then travels over the host network to Node 2's eth0.
11. Node 2's kernel network stack sees that the frame has a VXLAN header with VNI=1, so the kernel unpacks it, takes out the inner frame and, based on the VNI, hands it to flannel.1 on Node 2.
12. flannel.1 checks whether the frame's destination MAC is its own. If so, it unpacks further and takes out the original IP packet. Its destination IP is 10.244.1.3, which is on a directly connected route, so it is forwarded to cni0 via the routing table. The routes:

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

13. The packet reaches the cni0 bridge, is forwarded to the corresponding veth pair, and finally arrives in the target container. The packet format in VXLAN mode is shown below:

![](/images/k8s-network-1/19.png)

The fields explained:

- The packet has two parts, the inner packet and the outer packet. The inner packet is the logical overlay network; the outer packet is the real physical network.
- The inner IP header holds the IP addresses of container1 and container2, and its Ethernet header holds the addresses of the VTEP devices on the hosts, i.e. the MAC addresses of flannel.1 on the two hosts.
- The VXLAN header has an important field called the VNI, which a VTEP uses to decide whether a frame is meant for it. In Flannel the VNI defaults to 1, which is why the VTEP devices on the hosts are all called flannel.1: the "1" is the VNI.
- The outer frame's IP header holds the hosts' IP addresses, and its Ethernet header holds the hosts' real MAC addresses.
- The flannel.1 device (the VTEP) performs the second encapsulation.

**All of this encapsulation and decapsulation is done by a kernel mechanism, the VTEP device.**

Flannel is one solution for cross-node container networking. Its overlay comes in two main flavors: UDP, which encapsulates in user space, and VXLAN, which encapsulates in kernel space and performs better. Both can be called tunneling.

#### host-gw

host-gw works by setting the next hop for each Flannel subnet to the IP of the host that owns that subnet. This removes the cost of encapsulating and decapsulating packets during communication. As shown below:

![](/images/k8s-network-1/20.png)

1. container-1 sends a packet to 10.244.1.3. Following container-1's routes, it goes through the veth pair to the cni0 bridge and reaches the host.
2. In Flannel's host-gw mode, flanneld adds a route on the host:

```
$ ip route
10.244.1.0/24 via 10.168.0.3 dev eth0
```

It means IP packets destined for 10.244.1.0/24 should go out through the local eth0 device (dev eth0), with next hop 10.168.0.3 (the IP of the destination host, Node2).
3. With the next hop configured, when the IP packet moves from the network layer to the link layer and is framed, eth0 uses the MAC address of the next hop as the frame's destination MAC, which is of course Node 2's MAC.
4. The frame travels from Node 1 over the hosts' layer-2 network to Node 2.
5. After Node 2's kernel network stack extracts the IP packet from the frame, it "sees" that the destination IP is 10.244.1.3, the IP of Infra-container-2. According to Node 2's routing table, this address matches the second rule in the figure (the one for 10.244.1.0), so the packet enters the cni0 bridge. Since it is a directly connected route, the MAC address can be resolved directly, and the packet goes through the veth pair into Infra-container-2.

That is how host-gw mode works. The core idea is to set the "next hop" of each Flannel subnet (e.g. 10.244.1.0/24) to the IP of the host that owns it. In other words, that host acts as the "gateway" on the container's communication path, which is exactly what "host-gw" means.

Of course, Flannel's subnet and host information is all stored in etcd. flanneld just needs to WATCH it for changes and update the routing table in real time.

What makes host-gw work is that when an IP packet is framed and sent, the "next hop" in the routing table is used to set the destination MAC, so the frame reaches the destination host over the layer-2 network. This requires the cluster hosts to be connected at layer 2.

It has the best performance, but one fatal limitation: it can't span layer-2 subnets.

## Kubernetes ingress networking

From the outside in, the path is: ingress --> service --> pod

Pod-to-pod networking is solved by the schemes above, and every pod has a unique IP. But pods scale up and down and are stateless, so they can be destroyed and recreated at any time, which means their IPs keep changing. Talking pod to pod directly by IP is therefore impractical; we need Services. Pod IPs keep changing, but a Service's domain name is fixed, and Services also provide service discovery and load balancing.

### service

A Kubernetes Service defines an abstraction: a logical group of pods and a policy for reaching them, usually what we call a microservice. This group of pods can be reached through the Service.

Services work in one of three modes: userspace, iptables and ipvs.

### userspace

As shown below, when a client pod wants to reach a server pod, it first sends the request to the Service rules in the local kernel, which pass it to kube-proxy listening on a specific socket. kube-proxy processes the request and dispatches it to the chosen server pod, handing it back to the Service in kernel space, which then forwards it to that server pod.

![](/images/k8s-network-1/21.png)

Because it keeps going back and forth between user space and kernel space, this mode is very inefficient and has been deprecated, which led to the second mode.

### The iptables model

In this mode, iptables rules in the kernel receive the client pod's request directly, process it and forward it straight to the chosen server pod.

![](/images/k8s-network-1/22.png)

Its drawback: each pod means a chain of iptables rules, and every node must apply them. Beyond about 5,000 rules, every change makes performance drop sharply.

### The ipvs model

Here, ipvs rules in the kernel receive the client pod's request, process it, and after the kernel encapsulates it, send it straight to the chosen server pod.

![](/images/k8s-network-1/23.png)

In all of these modes, kube-proxy watches the latest pod state that kube-apiserver writes to etcd. As soon as it sees a pod deleted or created, it reflects the change in the iptables or ipvs rules, so that iptables and ipvs never route a client pod's request to a server pod that no longer exists.

### ingress

Services solve service discovery and load balancing for pods, but all of that still happens inside the cluster. How does traffic from outside the cluster get in?

The idea is to run an "nginx" on every node as a layer-7 proxy. For example, a domain is configured to point at a node's IP; the request carries the host name, reaches the ingress controller, which forwards it to the Service, and the Service forwards it to a pod.

Closing thoughts: every tall building rises from the ground up, and Kubernetes networking rests on this whole set of technologies. Early on, Kubernetes built networking itself; today it only defines the standard and leaves implementations to vendors, whose technologies each have their moment in the spotlight. Looking ahead, I think eBPF, one of the hottest technologies right now, will make Kubernetes networking even more efficient.

---

*Originally published in Chinese on the WeChat account "算法 SRE" ([original post](https://mp.weixin.qq.com/s/gtz87puW4TBFNwRmpvHmHw)).*
