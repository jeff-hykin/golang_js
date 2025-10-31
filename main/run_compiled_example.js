import { FS } from "./fs.js"
import { GoScaffolding, defaultWasmAccessibleGlobals } from "./go_scaffolding.js"
import { wasmBytes } from "something"

const goScaffolding = new GoScaffolding({
    wasmAccessibleGlobals: {
        ...defaultWasmAccessibleGlobals,
        // TODO: is the default fs needed? (e.g. files for go compiler)
        fs: new FS(),
        process: {
            cwd() {
                return fs.workingDirectory;
            },
        }
    }, 
})
const module = WebAssembly.instantiate(wasmBytes, goScaffolding.importObject)
export const runTheSomething = ({ args, onStdout, onStderr, extraAccessibleWasmGlobals, })=> goScaffolding.run(module.instance, { args, onStdout, onStderr, extraAccessibleWasmGlobals, })