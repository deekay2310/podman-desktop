---
sidebar_position: 4
---

# Troubleshooting

Here, find some answers to the question : I have downloaded Podman Desktop but I am unable to see any of my image or container

## Podman

### System Requirements

The tool connects to Podman using the socket on the host on macOS and on a named pipe on Windows. This is available only on podman 4.0.2+
So, please check your version and update.

On Windows, the named pipe is `//./pipe/docker_engine` when Docker Desktop is not installed. It will be solved by https://github.com/containers/podman/issues/13502 / https://github.com/containers/podman/pull/13655. During that time, you may start Docker Desktop so the named pipe is the one expected.

### Check connection

Check at least a podman machine is running on Windows & macOS:

```bash
podman machine list
```

And check a connection can be made with the CLI

```sh
$ podman run quay.io/podman/hello
!... Hello Podman World ...!

         .--"--.
       / -     - \
      / (O)   (O) \
   ~~~| -=(,Y,)=- |
    .---. /`  \   |~~
 ~/  o  o \~~~~.----. ~~
  | =(X)= |~  / (O (O) \
   ~~~~~~~  ~| =(Y_)=-  |
  ~~~~    ~~~|   U      |~~

Project:   https://github.com/containers/podman
Website:   https://podman.io
Documents: https://docs.podman.io
Twitter:   @Podman_io
```

### Fixing corrupted Podman Machine in Windows

If at all you are not able to stop your Podman Machine, you will find such an error in the Logs-
```Error: Error stopping sysd: exit status 1```

It is highly unlikely that you may be stuck in such a situation but if you are, here's a quick fix for it.

Assuming the name of the Podman Machine to be `my-machine`, run the following commands in the terminal:

```sh
wsl --list
```

This shall display a list of active distributions i.e. `my-machine` in this case.

Then,

```sh
wsl --unregister my-machine
```
(Replacing `my-machine` with the name that is displayed under `wsl --list` for your Podman Machine)

This will stop the Podman Machine for you.

## Code Ready Containers

- Check that podman preset is defined. (`crc config get preset`)
- Check that `crc` binary is available in the user PATH (`/usr/local/bin/crc`)
- Check that `crc setup --check-only` is running without errors.
