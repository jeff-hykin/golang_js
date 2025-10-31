import uint8ArrayForRuntimeA    from "../compiled_files/runtime.a.binaryified.js"
import uint8ArrayForBytealgA    from "../compiled_files/internal/bytealg.a.binaryified.js"
import uint8ArrayForCpuA        from "../compiled_files/internal/cpu.a.binaryified.js"
import uint8ArrayForAtomicA     from "../compiled_files/runtime/internal/atomic.a.binaryified.js"
import uint8ArrayForMathA       from "../compiled_files/runtime/internal/math.a.binaryified.js"
import uint8ArrayForSysA        from "../compiled_files/runtime/internal/sys.a.binaryified.js"

import { FS } from "./fs.js"

export const defaultFs = new FS()
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder('utf-8');
const importedFiles = {
    "prebuilt/runtime.a": uint8ArrayForRuntimeA,
    "prebuilt/internal/bytealg.a": uint8ArrayForBytealgA,
    "prebuilt/internal/cpu.a": uint8ArrayForCpuA,
    "prebuilt/runtime/internal/atomic.a": uint8ArrayForAtomicA,
    "prebuilt/runtime/internal/math.a": uint8ArrayForMathA,
    "prebuilt/runtime/internal/sys.a": uint8ArrayForSysA,
    '/importcfg': encoder.encode(
        "packagefile runtime=prebuilt/runtime.a"
    ),
    '/importcfg.link': encoder.encode(
        "packagefile command-line-arguments=main.a\n" +
        "packagefile runtime=prebuilt/runtime.a\n" +
        "packagefile internal/bytealg=prebuilt/internal/bytealg.a\n" +
        "packagefile internal/cpu=prebuilt/internal/cpu.a\n" +
        "packagefile runtime/internal/atomic=prebuilt/runtime/internal/atomic.a\n" +
        "packagefile runtime/internal/math=prebuilt/runtime/internal/math.a\n" +
        "packagefile runtime/internal/sys=prebuilt/runtime/internal/sys.a"
    ),
}
for (const [key, value] of Object.entries(importedFiles)) {
    defaultFs.ezWrite(key, value)
}