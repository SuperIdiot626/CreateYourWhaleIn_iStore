# 2026-10-31 · `\\<hostname>` 访问不了（0x80070035）

> 部署机上 Windows 客户端按主机名访问 SMB 共享失败。不是 SMB 挂了，是**名字被 Tailscale 抢走了**。
> 文中用占位符：`<hostname>` = 局域网里的主机名，`<name>` = 同一台机器在 tailnet 里的机名（常见情况是只差大小写）。

## 现象

- Windows 资源管理器访问 `\\<hostname>` → 「网络错误 0x80070035 找不到网络路径」。
- 用户描述「之前都是可以的」，且刚到家连上 WiFi。
- 同一时刻：
  - `ping <LAN-IP>` 通，`<LAN-IP>:445` 端口通 —— 服务和网络都没问题；
  - 但 `ping <hostname>` 解析到的是 **tailnet 地址**，不是 LAN 地址；
  - 用 `\\<LAN-IP>` 直连共享反而「拒绝访问」。
- `ping` 的显示暴露了线索：`Pinging <name>.<tailnet>.ts.net. [<tailnet-IP>]`。

## 根因

**主机名在局域网和 Tailscale 里撞名了，而 Windows 选了 Tailscale 那条。**

完整链条：

1. 同一台机器有两个名字：LAN 上叫 `<hostname>`，tailnet 里叫 `<name>`。两者只差大小写。
2. Tailscale 的 MagicDNS 会把 tailnet 机名以**短别名**的形式写进 Windows 的 hosts：

   ```
   <tailnet-IP>  <name>.<tailnet>.ts.net.  <name>
                                          ^^^^^^^ 短别名
   ```

3. **hosts 匹配不分大小写** → `<hostname>` 与 `<name>` 是同一个名字。
4. Windows 解析时会把 hosts 里所有命中的条目都返回（`Resolve-DnsName` 能看到两条），
   但实际连接取的是 Tailscale 那条 → 流量去了 `<tailnet-IP>`。
5. 而 Samba 只绑了 LAN 接口：

   ```
   interfaces = <lan-iface>
   bind interfaces only = yes
   ```

   `netstat` 里只有 `<LAN-IP>:445`，**tailnet 接口上 445 根本没监听** →
   连不上 → 「找不到网络路径」。

6. 附带一条同样致命的：**SMB 凭据是挂在「目标名」上的**。
   `cmdkey /list` 里是 `Domain:target=<hostname>`。所以名字指到哪台机器，凭据跟到哪；
   改用 `\\<LAN-IP>` 会因为没有该目标的凭据被拒（看到的是「拒绝访问」，不是「路径错误」）。
   —— 这决定了修法必须是「把名字修对」，而不是「改用 IP」。

### 走过的弯路（别重复）

一开始怀疑是 **DNS 后缀**问题（Tailscale 给适配器塞了 `<tailnet>.ts.net` 后缀，
Windows 解析单标签名时会先补后缀）。于是依次试了：

- 给 LAN 网卡设连接后缀（`Set-DnsClient -ConnectionSpecificSuffix`）→ 无效
- 清掉 Tailscale 网卡的连接后缀 → 无效
- 在 hosts 里加 `<LAN-IP> <hostname>`，分别放在 Tailscale 段之前 / 之后 → 都无效
- 验证 hosts 本身是生效的（用一个唯一假名测试能解析）、`nslookup <hostname>` 从局域网 DNS
  也能拿到 LAN 地址 → 说明 DNS 层是对的，只是**轮不到它**

真正原因在最后一步才看清：`Resolve-DnsName <hostname>` 同时返回两条记录
（Tailscale 的短别名 + 我们加的），而 Windows 取 Tailscale 那条。
**只要 MagicDNS 还在给这个名字注入短别名，hosts 里再加多少条都抢不过它。**

## 影响面

- 只影响 Windows 客户端**按短名**访问 SMB；不影响 tailnet 本身，也不影响局域网其它协议
  （SSH / HTTP 都正常，因为它们用的是不同的名字或直接 IP）。
- 不碰用户数据、不涉及密钥、不花钱。
- 失败是**报错**（0x80070035 / 拒绝访问），不是静默失败 —— 好事，容易定位。
- 网络变化会改变表现：离开家时本来就应该走 tailnet，所以「在家走 LAN」这条只能在家验证。

## 修法

目标是「**在家走局域网，出门才走 Tailscale**」，不是「能连上就行」。

对比过三条路：

| 方案 | 结论 |
|---|---|
| ① 让 SMB 也在 tailnet 接口上监听 | 能通，但等于在家也走 Tailscale，违反目标；且 Samba **绑不上 point-to-point 的 /32 地址**（`tailscale0` 和 `<tailnet-IP>/32` 都试过），只能 `bind interfaces only = no`，同时放宽了暴露面。放弃 |
| ② 改掉 tailnet 机名 | 能彻底消掉撞名，但会让 `tailscale serve` 的面板 URL 变化，影响既有书签。暂不选 |
| ③ **两个名字都固化 + 让 Tailscale 别管本机 DNS** | **采用** |

具体做法：

1. **Windows hosts 里把两个名字都钉死**（LAN 名 + tailnet 全名各给一条 A 记录）：

   ```
   <LAN-IP>      <hostname> <hostname>.lan
   <tailnet-IP>  <name>.<tailnet>.ts.net
   ```

2. **让 Tailscale 不再管理这台机器的 DNS**：

   ```powershell
   tailscale set --accept-dns=false
   ```

   否则它每次网络变化都会把那条短别名写回 hosts，修好又坏。
   代价是这台机器不再自动解析其它 tailnet 机名 —— 需要的话按同样的格式手工补进 hosts。

3. **服务器侧顺手补一条**：主机的 dnsmasq 原本连**它自己的裸主机名都不回答**
   （`nslookup <hostname> <LAN-IP>` → NXDOMAIN）。在 `/etc/hosts` 里加一行
   `<自己的 LAN 地址>  <hostname> <hostname>.lan`，局域网内所有设备就都能按短名解析了。

修完之后：在家 `\\<hostname>` → LAN；外出用 `<name>.<tailnet>.ts.net` → tailnet；
面板类 HTTP 服务（走 tailnet FQDN + serve）因为 hosts 里已有 A 记录，URL 不用改。

## 验证

```powershell
ping <hostname>                   # 期望 <LAN-IP>
ping <hostname>.lan               # 期望 <LAN-IP>
ping <name>.<tailnet>.ts.net      # 期望 <tailnet-IP>
Resolve-DnsName <hostname>        # 期望只剩一条 A，指向 <LAN-IP>（不再是 CNAME→tailnet）
dir \\<hostname>\<share>          # 能列目录
```

服务器侧：

```sh
nslookup <hostname> 127.0.0.1     # 期望返回 LAN 地址
grep -E '^\s*(interfaces|bind interfaces only)' /etc/samba/smb.conf
#   interfaces = <lan-iface>
#   bind interfaces only = yes
netstat -tlnp | grep 445          # 只应有 <LAN-IP>:445
```

## 回滚与残余

- **服务器**：改 `/etc/hosts` 前备份成 `/etc/hosts.bak.<时间戳>`；Samba 模板备份为
  `smb.conf.template.bak.<时间戳>`（本次已还原成原始配置，没有残留改动）。
- **PC**：删掉 hosts 里手工加的那几行，再 `tailscale set --accept-dns=true` 即可复原。
- **残余**：
  - 关掉 MagicDNS 后，这台 PC 不再自动解析 tailnet 其它机器名；已知的已手工补进 hosts，
    **以后新增设备要手动加**。
  - tailnet 地址是写死的 A 记录 —— 设备重新注册拿到新 IP 时要跟着改。
- **未验证**：
  - 外出时 SMB 共享是否可用（当前 Samba 仍只绑 LAN，本来就不该能用）。
  - 系统大版本升级 / Tailscale 重装后 `--accept-dns=false` 是否被重置（重装会，需重跑）。
