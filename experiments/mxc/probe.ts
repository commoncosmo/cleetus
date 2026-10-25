import { getPlatformSupport, probe } from "@microsoft/mxc-sdk/v1"; console.log(JSON.stringify({bun:Bun.version,arch:process.arch,support:getPlatformSupport(),probe:probe()},null,2));
