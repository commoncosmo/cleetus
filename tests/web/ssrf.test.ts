import { describe, expect, it } from "bun:test";
import { SsrfBlockedError, assertUrlAllowed, classifyAddress } from "../../src/web/ssrf";

const noResolve = async (): Promise<string[]> => {
  throw new Error("resolve should not be called for IP literals");
};
const resolveTo = (addrs: string[]) => async () => addrs;

describe("classifyAddress", () => {
  it("classifies IPv4 ranges", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.16.0.1")).toBe("private");
    expect(classifyAddress("172.32.0.1")).toBe("public");
    expect(classifyAddress("192.168.1.1")).toBe("private");
    expect(classifyAddress("169.254.169.254")).toBe("linklocal");
  });
  it("classifies IPv6 ranges", () => {
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("fe80::1")).toBe("linklocal");
    expect(classifyAddress("fc00::1")).toBe("private");
    expect(classifyAddress("2606:4700::1111")).toBe("public");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
  });
  it("blocks unspecified and expanded/compressed loopback and mapped forms", () => {
    expect(classifyAddress("0.0.0.0")).toBe("loopback");
    expect(classifyAddress("::")).toBe("loopback");
    expect(classifyAddress("0:0:0:0:0:0:0:1")).toBe("loopback");
    expect(classifyAddress("::ffff:7f00:1")).toBe("loopback"); // hex-mapped 127.0.0.1
    expect(classifyAddress("fe80::1")).toBe("linklocal"); // still works
    expect(classifyAddress("2606:4700::1111")).toBe("public"); // still works
  });
});

describe("assertUrlAllowed", () => {
  const pol = { allowLocalhost: false };
  it("allows a public IP literal", async () => {
    await assertUrlAllowed(new URL("https://8.8.8.8/"), pol, noResolve);
  });
  it("rejects non-http(s) schemes", async () => {
    await expect(assertUrlAllowed(new URL("file:///etc/passwd"), pol, noResolve)).rejects.toThrow(
      SsrfBlockedError,
    );
  });
  it("rejects loopback literal by default", async () => {
    await expect(assertUrlAllowed(new URL("http://127.0.0.1/"), pol, noResolve)).rejects.toThrow();
  });
  it("rejects cloud-metadata even with allowLocalhost", async () => {
    await expect(
      assertUrlAllowed(new URL("http://169.254.169.254/"), { allowLocalhost: true }, noResolve),
    ).rejects.toThrow();
  });
  it("allows loopback when allowLocalhost is true", async () => {
    await assertUrlAllowed(new URL("http://127.0.0.1:3000/"), { allowLocalhost: true }, noResolve);
  });
  it("rejects a hostname that resolves to a private IP", async () => {
    await expect(
      assertUrlAllowed(new URL("https://evil.example/"), pol, resolveTo(["10.0.0.5"])),
    ).rejects.toThrow();
  });
  it("allows a hostname that resolves to public IPs", async () => {
    await assertUrlAllowed(new URL("https://good.example/"), pol, resolveTo(["93.184.216.34"]));
  });

  it("returns the validated IP literal to pin", async () => {
    expect(await assertUrlAllowed(new URL("https://8.8.8.8/"), pol, noResolve)).toBe("8.8.8.8");
  });

  it("returns the first resolved address to pin the connection to", async () => {
    const pinned = await assertUrlAllowed(
      new URL("https://good.example/"),
      pol,
      resolveTo(["93.184.216.34", "93.184.216.35"]),
    );
    expect(pinned).toBe("93.184.216.34");
  });

  it("refuses when ANY resolved address is blocked (no cherry-picking a safe one)", async () => {
    // The rebinding/multi-record defense: if a hostname resolves to a mix of
    // public and private addresses, refuse rather than pin the public one — the
    // connection must never have a path to an internal address.
    await expect(
      assertUrlAllowed(
        new URL("https://evil.example/"),
        pol,
        resolveTo(["93.184.216.34", "10.0.0.5"]),
      ),
    ).rejects.toThrow(SsrfBlockedError);
  });
});
