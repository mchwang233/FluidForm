---
name: flexlm-license
description: Reach a FlexLM (FlexNet) license server from the step sandbox, and fix "cannot check out a license" errors of EDA tools (Synopsys snpslmd, Cadence cdslmd, Siemens mgcld). For environment repairs and steps whose tools need a license.
summary: 让步骤沙箱连上 FlexLM 许可证服务，处理 EDA 工具拿不到许可证的问题
tools: [lmgrd, lmutil, lmstat, snpslmd, cdslmd, mgcld, flexlm, flexnet, SNPSLMD_LICENSE_FILE, LM_LICENSE_FILE]
---

# FlexLM license servers

A FlexLM server is two kinds of processes: `lmgrd`, on the port in the license file's `SERVER`
line (often 27000-27009, or one like 26585), and one vendor daemon per vendor (`snpslmd` for
Synopsys, `cdslmd` for Cadence, `mgcld` for Siemens), which the tools talk to after asking lmgrd.
The vendor daemon picks a **new random port at every start** unless the license file fixes it.

The step sandbox reaches only the host ports listed in `sandbox.json`'s `host_ports` (or the
`SUPER_PARTNER_SANDBOX_HOST_PORTS` setting). So both ports must be fixed and listed: lmgrd's, and
each vendor daemon's.

## Symptoms

- `Failed to obtain license`, `FlexNet Licensing error:-15` (cannot connect), `-96` (server
  hostname not found), `-97` (vendor daemon down): the tool reached lmgrd but not the daemon, or
  neither.
- Works on the host, fails in a step: a port is not listed, or the daemon's port changed since.

## Fix

1. Find the license file and its ports, on the host:

   ```sh
   ps -eo user,pid,ppid,args | grep -E '[l]mgrd|[s]npslmd|[c]dslmd|[m]gcld'
   grep -nE '^(SERVER|VENDOR|DAEMON)' <license file>
   lmutil lmstat -a -c <lmgrd port>@localhost | head -20
   ```

   The `-c` argument of lmgrd is the license file. `lmstat` says whether the vendor daemon is up.

2. Fix the vendor daemon's port in the license file: on its `VENDOR` (or `DAEMON`) line add
   `PORT=<port>`, e.g. `VENDOR snpslmd PORT=27021`. Use the port it listens on now
   (`ss -ltnp` as the user running lmgrd) to change nothing else, or a free one.

3. Restart the server with the license file, as the user that runs it (often root; ask the user
   when you cannot):

   ```sh
   lmutil lmdown -c <license file> -q
   lmgrd -c <license file> -l <log file>
   ```

4. List both ports in `<tools>/sandbox.json`, keeping what is there, and point the tools at lmgrd:

   ```json
   {"env": {"SNPSLMD_LICENSE_FILE": "26585@localhost", "LM_LICENSE_FILE": "26585@localhost"},
    "host_ports": [26585, 27021]}
   ```

   Remove a vendor daemon port listed before that is no longer used.

5. Check it the way a step will: in the sandbox, `lmutil lmstat -a -c 26585@localhost`, then run
   the tool's smallest command (`vcs -ID`).

## Report

Say which ports are listed now, and whether the user still has to restart lmgrd (a fixed `PORT=`
takes effect only after a restart).
