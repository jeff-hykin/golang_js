import { FS } from "./fs.js"
import { GoRunner, defaultWasmAccessibleGlobals } from "./go_runner.js"
import { wasmBytes } from "something"

const goScaffolding = new GoRunner({
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