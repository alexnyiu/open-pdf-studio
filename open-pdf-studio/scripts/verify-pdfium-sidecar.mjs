import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function requireBytes(bytes, minimum, format) {
  if (bytes.byteLength < minimum) {
    throw new Error(`${format} header is truncated (${bytes.byteLength} bytes)`);
  }
}

function cpuArchitecture(cpuType) {
  switch (cpuType >>> 0) {
    case CPU_TYPE_X86_64:
      return 'x86_64';
    case CPU_TYPE_ARM64:
      return 'arm64';
    default:
      return `unknown-cpu-0x${(cpuType >>> 0).toString(16)}`;
  }
}

function inspectMachO(bytes) {
  const magic = bytes.readUInt32BE(0);
  const thinHeaders = new Map([
    [0xcefaedfe, 'LE'],
    [0xcffaedfe, 'LE'],
    [0xfeedface, 'BE'],
    [0xfeedfacf, 'BE'],
  ]);
  const thinEndian = thinHeaders.get(magic);
  if (thinEndian) {
    requireBytes(bytes, 8, 'Mach-O');
    const cpuType = thinEndian === 'LE'
      ? bytes.readUInt32LE(4)
      : bytes.readUInt32BE(4);
    return { format: 'mach-o', architectures: [cpuArchitecture(cpuType)] };
  }

  const fatHeaders = new Map([
    [0xcafebabe, { endian: 'BE', entrySize: 20 }],
    [0xcafebabf, { endian: 'BE', entrySize: 32 }],
    [0xbebafeca, { endian: 'LE', entrySize: 20 }],
    [0xbfbafeca, { endian: 'LE', entrySize: 32 }],
  ]);
  const fat = fatHeaders.get(magic);
  if (!fat) return null;

  requireBytes(bytes, 8, 'fat Mach-O');
  const readUInt32 = fat.endian === 'BE'
    ? Buffer.prototype.readUInt32BE
    : Buffer.prototype.readUInt32LE;
  const count = readUInt32.call(bytes, 4);
  if (count === 0 || count > 32) {
    throw new Error(`fat Mach-O has invalid architecture count ${count}`);
  }
  requireBytes(bytes, 8 + count * fat.entrySize, 'fat Mach-O');
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * fat.entrySize;
    architectures.push(cpuArchitecture(readUInt32.call(bytes, offset)));
  }
  return { format: 'mach-o-fat', architectures: [...new Set(architectures)] };
}

function inspectElf(bytes) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return null;
  }
  requireBytes(bytes, 20, 'ELF');
  const encoding = bytes[5];
  const machine = encoding === 1
    ? bytes.readUInt16LE(18)
    : encoding === 2
      ? bytes.readUInt16BE(18)
      : null;
  if (machine === null) throw new Error(`ELF has invalid byte order ${encoding}`);
  const architecture = machine === 62
    ? 'x86_64'
    : machine === 183
      ? 'arm64'
      : `unknown-machine-${machine}`;
  return { format: 'elf', architectures: [architecture] };
}

function inspectPe(bytes) {
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  requireBytes(bytes, 0x40, 'PE');
  const peOffset = bytes.readUInt32LE(0x3c);
  requireBytes(bytes, peOffset + 6, 'PE');
  if (!bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0'))) {
    throw new Error('PE signature is missing');
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const architecture = machine === 0x8664
    ? 'x86_64'
    : machine === 0xaa64
      ? 'arm64'
      : `unknown-machine-0x${machine.toString(16)}`;
  return { format: 'pe', architectures: [architecture] };
}

export function inspectExecutable(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  requireBytes(bytes, 4, 'executable');
  const inspected = inspectMachO(bytes) ?? inspectElf(bytes) ?? inspectPe(bytes);
  if (!inspected) throw new Error('unrecognized executable format');
  return inspected;
}

export function expectedArchitectures(target) {
  if (target === 'universal-apple-darwin') return ['arm64', 'x86_64'];
  if (target.startsWith('aarch64-')) return ['arm64'];
  if (target.startsWith('x86_64-')) return ['x86_64'];
  throw new Error(`unsupported sidecar target ${target}`);
}

export function verifyExecutableTarget(input, target) {
  const inspected = inspectExecutable(input);
  const expected = expectedArchitectures(target);
  const missing = expected.filter((architecture) => !inspected.architectures.includes(architecture));
  if (missing.length > 0) {
    throw new Error(
      `sidecar architecture mismatch for ${target}: expected ${expected.join('+')}, `
      + `found ${inspected.architectures.join('+')} (${inspected.format})`,
    );
  }
  return { target, ...inspected };
}

async function main() {
  const [target, binaryPath] = process.argv.slice(2);
  if (!target || !binaryPath) {
    throw new Error('usage: node scripts/verify-pdfium-sidecar.mjs <target> <binary>');
  }
  const result = verifyExecutableTarget(await readFile(binaryPath), target);
  process.stdout.write(`${JSON.stringify({ ...result, binaryPath })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
