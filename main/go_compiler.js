import { FS } from "./fs.js"
import { GoRunner, defaultWasmAccessibleGlobals } from "./go_runner.js"
import { defaultFs } from "./init_default_fs.js"
import uint8ArrayForCompileWasm from "../compiled_files/wasm/compile.wasm.binaryified.js"
import uint8ArrayForGofmtWasm   from "../compiled_files/wasm/gofmt.wasm.binaryified.js"
import uint8ArrayForLinkWasm    from "../compiled_files/wasm/link.wasm.binaryified.js"


// 
// setup Go Runner
// 
const wasmFiles = {
    "compile": uint8ArrayForCompileWasm,
    "link": uint8ArrayForLinkWasm,
    "gofmt": uint8ArrayForGofmtWasm,
}
export class GoCompiler {
    constructor({ fs, wasmAccessibleExtras, wasmAccessibleGlobals, }) {
        fs = fs || defaultFs.clone()
        this.fs = fs
        if (!wasmAccessibleGlobals) {
            wasmAccessibleGlobals = {
                ...defaultWasmAccessibleGlobals,
                process: {
                    cwd() {
                        return fs.workingDirectory;
                    },
                },
                fs,
            }
        }
        Object.assign(wasmAccessibleGlobals, wasmAccessibleExtras)
        
        this.scaffolding = new GoRunner({ wasmAccessibleGlobals })
        this.busy = null
        
        const cache = {}
        for (let [eachName, bytes] of [['compile', uint8ArrayForCompileWasm ], ['link', uint8ArrayForLinkWasm], ['gofmt', uint8ArrayForGofmtWasm]]) {
            cache[eachName] = null
            this["_"+eachName] = ({onStdout, onStderr, args}) => {
                if (!cache[eachName]) {
                    cache[eachName] = WebAssembly.instantiate(bytes, this.scaffolding.importObject)
                }
                return cache[eachName].then((module) => this.scaffolding.run(module.instance, { args, onStdout, onStderr }))
            }
        }
    }
    compileCmd({onStdout, onStderr}, ...args) {
        // this is setup in the constructor
        // this wrapper is to help with static typing/analysis
        return this._compile({onStdout, onStderr, args})
    }
    linkCmd({onStdout, onStderr}, ...args) {
        // this is setup in the constructor
        // this wrapper is to help with static typing/analysis
        return this._link({onStdout, onStderr, args})
    }
    gofmtCmd({onStdout, onStderr}, ...args) {
        // this is setup in the constructor
        // this wrapper is to help with static typing/analysis
        return this._gofmt({onStdout, onStderr, args})
    }
    async compile(body, {onStdout, onStderr}={}) {
        this.fs.ezWrite('/main.go', body)
        const streams = { onStdout, onStderr, }

        var result = this.compileCmd(streams, '-p', 'main', '-complete', '-dwarf=false', '-pack', '-importcfg', 'importcfg', 'main.go')
        var code = await result.exitCode
        if (code === 0) {
            result.error = new Error('compiling failed, see stderr')
            return result.error
        }
        result.exitCode = code
        const compileResult = result

        var result = this.linkCmd(streams, '-importcfg', 'importcfg.link', '-buildmode=exe', 'main.a')
        var code = await result.exitCode
        if (code === 0) {
            result.error = new Error('linking failed, see stderr')
            return result.error
        }
        result.exitCode = code
        const linkResult = result
        
        return { compiledBytes: this.fs.ezRead('a.out'), compileResult, linkResult }
    }
}