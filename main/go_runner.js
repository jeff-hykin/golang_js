// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license

// heavily modified by Jeff Hykin 2025

const defaultExitFunction = (code) => {
    if (code !== 0) {
        console.warn("exit code:", code)
    }
}

export class GoRunner {
    constructor({ wasmAccessibleGlobals, }) {
        this._wasmAccessibleGlobals = wasmAccessibleGlobals
        this.argv = ["js"]
        this.env = {}
        this._exitPromise = new Promise((resolve) => {
            this._resolveExitPromise = resolve
        })
        this._pendingEvent = null
        this._scheduledTimeouts = new Map()
        this._nextCallbackTimeoutID = 1
        this._busy = false

        const mem = () => {
            // The buffer may change when requesting more memory.
            return new DataView(this._inst.exports.mem.buffer)
        }

        const setInt64 = (addr, v) => {
            mem().setUint32(addr + 0, v, true)
            mem().setUint32(addr + 4, Math.floor(v / 4294967296), true)
        }

        const getInt64 = (addr) => {
            const low = mem().getUint32(addr + 0, true)
            const high = mem().getInt32(addr + 4, true)
            return low + high * 4294967296
        }

        const loadValue = (addr) => {
            const f = mem().getFloat64(addr, true)
            if (f === 0) {
                return undefined
            }
            if (!isNaN(f)) {
                return f
            }

            const id = mem().getUint32(addr, true)
            return this._values[id]
        }

        const storeValue = (addr, v) => {
            const nanHead = 0x7ff80000

            if (typeof v === "number") {
                if (isNaN(v)) {
                    mem().setUint32(addr + 4, nanHead, true)
                    mem().setUint32(addr, 0, true)
                    return
                }
                if (v === 0) {
                    mem().setUint32(addr + 4, nanHead, true)
                    mem().setUint32(addr, 1, true)
                    return
                }
                mem().setFloat64(addr, v, true)
                return
            }

            switch (v) {
                case undefined:
                    mem().setFloat64(addr, 0, true)
                    return
                case null:
                    mem().setUint32(addr + 4, nanHead, true)
                    mem().setUint32(addr, 2, true)
                    return
                case true:
                    mem().setUint32(addr + 4, nanHead, true)
                    mem().setUint32(addr, 3, true)
                    return
                case false:
                    mem().setUint32(addr + 4, nanHead, true)
                    mem().setUint32(addr, 4, true)
                    return
            }

            let ref = this._refs.get(v)
            if (ref === undefined) {
                ref = this._values.length
                this._values.push(v)
                this._refs.set(v, ref)
            }
            let typeFlag = 0
            switch (typeof v) {
                case "string":
                    typeFlag = 1
                    break
                case "symbol":
                    typeFlag = 2
                    break
                case "function":
                    typeFlag = 3
                    break
            }
            mem().setUint32(addr + 4, nanHead | typeFlag, true)
            mem().setUint32(addr, ref, true)
        }

        const loadSlice = (addr) => {
            const array = getInt64(addr + 0)
            const len = getInt64(addr + 8)
            return new Uint8Array(this._inst.exports.mem.buffer, array, len)
        }

        const loadSliceOfValues = (addr) => {
            const array = getInt64(addr + 0)
            const len = getInt64(addr + 8)
            const a = new Array(len)
            for (let i = 0; i < len; i++) {
                a[i] = loadValue(array + i * 8)
            }
            return a
        }

        const loadString = (addr) => {
            const saddr = getInt64(addr + 0)
            const len = getInt64(addr + 8)
            return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len))
        }

        const timeOrigin = Date.now() - performance.now()
        this.importObject = {
            go: {
                // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
                // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
                // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
                // This changes the SP, thus we have to update the SP used by the imported function.

                // func wasmExit(code int32)
                "runtime.wasmExit": (sp) => {
                    const code = mem().getInt32(sp + 8, true)
                    this.exited = true
                    delete this._inst
                    delete this._values
                    delete this._refs
                    this._resolveExitPromise(code)
                },

                // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
                "runtime.wasmWrite": (sp) => {
                    const fd = getInt64(sp + 8)
                    const p = getInt64(sp + 16)
                    const n = mem().getInt32(sp + 24, true)
                    this.wasmAccessibleGlobals.fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n))
                },

                // func nanotime() int64
                "runtime.nanotime": (sp) => {
                    setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000)
                },

                // func walltime() (sec int64, nsec int32)
                "runtime.walltime": (sp) => {
                    const msec = new Date().getTime()
                    setInt64(sp + 8, msec / 1000)
                    mem().setInt32(sp + 16, (msec % 1000) * 1000000, true)
                },

                // func scheduleTimeoutEvent(delay int64) int32
                "runtime.scheduleTimeoutEvent": (sp) => {
                    const id = this._nextCallbackTimeoutID
                    this._nextCallbackTimeoutID++
                    this._scheduledTimeouts.set(
                        id,
                        setTimeout(
                            () => {
                                this._resume()
                            },
                            getInt64(sp + 8) + 1 // setTimeout has been seen to fire up to 1 millisecond early
                        )
                    )
                    mem().setInt32(sp + 16, id, true)
                },

                // func clearTimeoutEvent(id int32)
                "runtime.clearTimeoutEvent": (sp) => {
                    const id = mem().getInt32(sp + 8, true)
                    clearTimeout(this._scheduledTimeouts.get(id))
                    this._scheduledTimeouts.delete(id)
                },

                // func getRandomData(r []byte)
                "runtime.getRandomData": (sp) => {
                    crypto.getRandomValues(loadSlice(sp + 8))
                },

                // func stringVal(value string) ref
                "syscall/js.stringVal": (sp) => {
                    storeValue(sp + 24, loadString(sp + 8))
                },

                // func valueGet(v ref, p string) ref
                "syscall/js.valueGet": (sp) => {
                    const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16))
                    sp = this._inst.exports.getsp() // see comment above
                    storeValue(sp + 32, result)
                },

                // func valueSet(v ref, p string, x ref)
                "syscall/js.valueSet": (sp) => {
                    Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32))
                },

                // func valueIndex(v ref, i int) ref
                "syscall/js.valueIndex": (sp) => {
                    storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)))
                },

                // valueSetIndex(v ref, i int, x ref)
                "syscall/js.valueSetIndex": (sp) => {
                    Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24))
                },

                // func valueCall(v ref, m string, args []ref) (ref, bool)
                "syscall/js.valueCall": (sp) => {
                    try {
                        const v = loadValue(sp + 8)
                        const m = Reflect.get(v, loadString(sp + 16))
                        const args = loadSliceOfValues(sp + 32)
                        const result = Reflect.apply(m, v, args)
                        sp = this._inst.exports.getsp() // see comment above
                        storeValue(sp + 56, result)
                        mem().setUint8(sp + 64, 1)
                    } catch (err) {
                        storeValue(sp + 56, err)
                        mem().setUint8(sp + 64, 0)
                    }
                },

                // func valueInvoke(v ref, args []ref) (ref, bool)
                "syscall/js.valueInvoke": (sp) => {
                    try {
                        const v = loadValue(sp + 8)
                        const args = loadSliceOfValues(sp + 16)
                        const result = Reflect.apply(v, undefined, args)
                        sp = this._inst.exports.getsp() // see comment above
                        storeValue(sp + 40, result)
                        mem().setUint8(sp + 48, 1)
                    } catch (err) {
                        storeValue(sp + 40, err)
                        mem().setUint8(sp + 48, 0)
                    }
                },

                // func valueNew(v ref, args []ref) (ref, bool)
                "syscall/js.valueNew": (sp) => {
                    try {
                        const v = loadValue(sp + 8)
                        const args = loadSliceOfValues(sp + 16)
                        const result = Reflect.construct(v, args)
                        sp = this._inst.exports.getsp() // see comment above
                        storeValue(sp + 40, result)
                        mem().setUint8(sp + 48, 1)
                    } catch (err) {
                        storeValue(sp + 40, err)
                        mem().setUint8(sp + 48, 0)
                    }
                },

                // func valueLength(v ref) int
                "syscall/js.valueLength": (sp) => {
                    setInt64(sp + 16, parseInt(loadValue(sp + 8).length))
                },

                // valuePrepareString(v ref) (ref, int)
                "syscall/js.valuePrepareString": (sp) => {
                    const str = encoder.encode(String(loadValue(sp + 8)))
                    storeValue(sp + 16, str)
                    setInt64(sp + 24, str.length)
                },

                // valueLoadString(v ref, b []byte)
                "syscall/js.valueLoadString": (sp) => {
                    const str = loadValue(sp + 8)
                    loadSlice(sp + 16).set(str)
                },

                // func valueInstanceOf(v ref, t ref) bool
                "syscall/js.valueInstanceOf": (sp) => {
                    mem().setUint8(sp + 24, loadValue(sp + 8) instanceof loadValue(sp + 16))
                },

                debug: (value) => {
                    console.log(value)
                },
            },
        }
    }

    run(instance, { args, onStdout, onStderr, extraAccessibleWasmGlobals, }) {
        if (this._busy) {
            throw Error(`Still running previous request, do not call run while a previous run is running. Create a new instance of GoRunner to run multiple requests simultaneously`)
        }
        let combinedChunks = []
        let stdoutChunks = []
        let stderrChunks = []
        this._wasmAccessibleGlobals.goStderr = (buf) => {
            if (onStderr) {
                try {
                    Promise.resolve(onStderr(buf)).catch((error) => {
                        console.error(`${(error?.message||error)}\n${error?.stack}`)
                    })
                } catch (error) {
                    console.error(`${(error?.message||error)}\n${error?.stack}`)
                }
            }
            combinedChunks.push(buf)
            stderrChunks.push(buf)
        };
        this._wasmAccessibleGlobals.goStdout = (buf) => {
            if (onStdout) {
                try {
                    Promise.resolve(onStdout(buf)).catch((error) => {
                        console.error(`${(error?.message||error)}\n${error?.stack}`)
                    })
                } catch (error) {
                    console.error(`${(error?.message||error)}\n${error?.stack}`)
                }
            }
            combinedChunks.push(buf)
            stdoutChunks.push(buf)
        };
        this._busy = true
        this._exitPromise = new Promise((resolve) => {
            this._resolveExitPromise = (exitCode)=>{
                // protects against multiple calls to resolveExitPromise without multiple calls to run
                if (this._busy) {
                    this._busy = false
                    resolve(exitCode)
                }
            }
        })
        
        this.argv = this.argv.concat(args || []);
        this._inst = instance
        let accessible = this._wasmAccessibleGlobals
        if (extraAccessibleWasmGlobals) {
            accessible = {...this._wasmAccessibleGlobals, ...extraAccessibleWasmGlobals}
        }
        // TODO:
        // might need to add these to the accessible globals (do it if stuff fails)
            // fs.filesystem
            // fs.openFiles
            // fs.workingDirectory
            // fs.nextFd
        this._values = [
            // TODO: garbage collection
            NaN,
            0,
            null,
            true,
            false,
            accessible,
            this._inst.exports.mem,
            this,
        ]
        this._refs = new Map()
        this.exited = false

        const mem = new DataView(this._inst.exports.mem.buffer)

        // Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
        let offset = 4096

        const strPtr = (str) => {
            let ptr = offset
            new Uint8Array(mem.buffer, offset, str.length + 1).set(encoder.encode(str + "\0"))
            offset += str.length + (8 - (str.length % 8))
            return ptr
        }

        const argc = this.argv.length

        const argvPtrs = []
        this.argv.forEach((arg) => {
            argvPtrs.push(strPtr(arg))
        })

        const keys = Object.keys(this.env).sort()
        argvPtrs.push(keys.length)
        keys.forEach((key) => {
            argvPtrs.push(strPtr(`${key}=${this.env[key]}`))
        })

        const argv = offset
        argvPtrs.forEach((ptr) => {
            mem.setUint32(offset, ptr, true)
            mem.setUint32(offset + 4, 0, true)
            offset += 8
        })

        this._inst.exports.run(argc, argv)
        const output = {
            exitCode: this._exitPromise,
            stderrChunks,
            stdoutChunks,
            combinedChunks,
        }
        Object.defineProperties(output, {
            stdoutStr: {
                get() {
                    const decoder = new TextDecoder("utf-8")
                    return stdoutChunks.map(decoder.decode).join('')
                }
            },
            stderrStr: {
                get() {
                    const decoder = new TextDecoder("utf-8")
                    return stderrChunks.map(decoder.decode).join('')
                }
            },
            combinedStr: {
                get() {
                    const decoder = new TextDecoder("utf-8")
                    return combinedChunks.map(decoder.decode).join('')
                }
            },
        })
        return output
    }

    _resume() {
        if (this.exited) {
            throw new Error("Go program has already exited")
        }
        this._inst.exports.resume()
    }

    _makeFuncWrapper(id) {
        const go = this
        return function (...args) {
            const event = { id: id, this: this, args: args }
            go._pendingEvent = event
            go._resume()
            return event.result
        }
    }
}

export const defaultWasmAccessibleGlobals = {
    readFromGoFilesystem: fs.ezRead,
    writeToGoFilesystem: fs.ezWrite,
    // fs: fs,
    goStdout: (buf) => { console.log(new TextDecoder("utf-8").decode(buf))}, // TODO: make sure doesn't throw error on decoding invalid utf-8
    goStderr: (buf) => { console.log(new TextDecoder("utf-8").decode(buf))},
    // process: {
    //     cwd() {
    //         return fs.workingDirectory;
    //     },
    // },
    Go: GoRunner,
    
    // normal globals
    __defineGetter__: globalThis.__defineGetter__,
    __defineSetter__: globalThis.__defineSetter__,
    __lookupGetter__: globalThis.__lookupGetter__,
    __lookupSetter__: globalThis.__lookupSetter__,
    _error: globalThis._error,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    addEventListener: globalThis.addEventListener,
    AggregateError: globalThis.AggregateError,
    alert: globalThis.alert,
    Array: globalThis.Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    AsyncDisposableStack: globalThis.AsyncDisposableStack,
    atob: globalThis.atob,
    Atomics: globalThis.Atomics,
    BigInt: globalThis.BigInt,
    BigInt64Array: globalThis.BigInt64Array,
    BigUint64Array: globalThis.BigUint64Array,
    Blob: globalThis.Blob,
    Boolean: globalThis.Boolean,
    btoa: globalThis.btoa,
    Buffer: globalThis.Buffer,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    Cache: globalThis.Cache,
    caches: globalThis.caches,
    CacheStorage: globalThis.CacheStorage,
    clear: globalThis.clear,
    clearImmediate: globalThis.clearImmediate,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
    close: globalThis.close,
    closed: globalThis.closed,
    CloseEvent: globalThis.CloseEvent,
    CompressionStream: globalThis.CompressionStream,
    confirm: globalThis.confirm,
    console: globalThis.console,
    constructor: globalThis.constructor,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,
    createImageBitmap: globalThis.createImageBitmap,
    crypto: globalThis.crypto,
    Crypto: globalThis.Crypto,
    CryptoKey: globalThis.CryptoKey,
    CustomEvent: globalThis.CustomEvent,
    DataView: globalThis.DataView,
    Date: globalThis.Date,
    decodeURI: globalThis.decodeURI,
    decodeURIComponent: globalThis.decodeURIComponent,
    DecompressionStream: globalThis.DecompressionStream,
    dispatchEvent: globalThis.dispatchEvent,
    DisposableStack: globalThis.DisposableStack,
    DOMException: globalThis.DOMException,
    encodeURI: globalThis.encodeURI,
    encodeURIComponent: globalThis.encodeURIComponent,
    Error: globalThis.Error,
    ErrorEvent: globalThis.ErrorEvent,
    escape: globalThis.escape,
    eval: globalThis.eval,
    EvalError: globalThis.EvalError,
    Event: globalThis.Event,
    EventSource: globalThis.EventSource,
    EventTarget: globalThis.EventTarget,
    fetch: globalThis.fetch,
    File: globalThis.File,
    FileReader: globalThis.FileReader,
    FinalizationRegistry: globalThis.FinalizationRegistry,
    Float16Array: globalThis.Float16Array,
    Float32Array: globalThis.Float32Array,
    Float64Array: globalThis.Float64Array,
    FormData: globalThis.FormData,
    Function: globalThis.Function,
    getParent: globalThis.getParent,
    global: globalThis.global,
    globalThis: globalThis.globalThis,
    GPU: globalThis.GPU,
    GPUAdapter: globalThis.GPUAdapter,
    GPUAdapterInfo: globalThis.GPUAdapterInfo,
    GPUBindGroup: globalThis.GPUBindGroup,
    GPUBindGroupLayout: globalThis.GPUBindGroupLayout,
    GPUBuffer: globalThis.GPUBuffer,
    GPUBufferUsage: globalThis.GPUBufferUsage,
    GPUCanvasContext: globalThis.GPUCanvasContext,
    GPUColorWrite: globalThis.GPUColorWrite,
    GPUCommandBuffer: globalThis.GPUCommandBuffer,
    GPUCommandEncoder: globalThis.GPUCommandEncoder,
    GPUComputePassEncoder: globalThis.GPUComputePassEncoder,
    GPUComputePipeline: globalThis.GPUComputePipeline,
    GPUDevice: globalThis.GPUDevice,
    GPUDeviceLostInfo: globalThis.GPUDeviceLostInfo,
    GPUError: globalThis.GPUError,
    GPUInternalError: globalThis.GPUInternalError,
    GPUMapMode: globalThis.GPUMapMode,
    GPUOutOfMemoryError: globalThis.GPUOutOfMemoryError,
    GPUPipelineError: globalThis.GPUPipelineError,
    GPUPipelineLayout: globalThis.GPUPipelineLayout,
    GPUQuerySet: globalThis.GPUQuerySet,
    GPUQueue: globalThis.GPUQueue,
    GPURenderBundle: globalThis.GPURenderBundle,
    GPURenderBundleEncoder: globalThis.GPURenderBundleEncoder,
    GPURenderPassEncoder: globalThis.GPURenderPassEncoder,
    GPURenderPipeline: globalThis.GPURenderPipeline,
    GPUSampler: globalThis.GPUSampler,
    GPUShaderModule: globalThis.GPUShaderModule,
    GPUShaderStage: globalThis.GPUShaderStage,
    GPUSupportedFeatures: globalThis.GPUSupportedFeatures,
    GPUSupportedLimits: globalThis.GPUSupportedLimits,
    GPUTexture: globalThis.GPUTexture,
    GPUTextureUsage: globalThis.GPUTextureUsage,
    GPUTextureView: globalThis.GPUTextureView,
    GPUUncapturedErrorEvent: globalThis.GPUUncapturedErrorEvent,
    GPUValidationError: globalThis.GPUValidationError,
    hasOwnProperty: globalThis.hasOwnProperty,
    Headers: globalThis.Headers,
    ImageBitmap: globalThis.ImageBitmap,
    ImageData: globalThis.ImageData,
    Infinity: globalThis.Infinity,
    Int16Array: globalThis.Int16Array,
    Int32Array: globalThis.Int32Array,
    Int8Array: globalThis.Int8Array,
    Intl: globalThis.Intl,
    isFinite: globalThis.isFinite,
    isNaN: globalThis.isNaN,
    isPrototypeOf: globalThis.isPrototypeOf,
    Iterator: globalThis.Iterator,
    JSON: globalThis.JSON,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
    Location: globalThis.Location,
    Map: globalThis.Map,
    Math: globalThis.Math,
    MessageChannel: globalThis.MessageChannel,
    MessageEvent: globalThis.MessageEvent,
    MessagePort: globalThis.MessagePort,
    name: globalThis.name,
    NaN: globalThis.NaN,
    navigator: globalThis.navigator,
    Navigator: globalThis.Navigator,
    Number: globalThis.Number,
    Object: globalThis.Object,
    onbeforeunload: globalThis.onbeforeunload,
    onerror: globalThis.onerror,
    onload: globalThis.onload,
    onunhandledrejection: globalThis.onunhandledrejection,
    onunload: globalThis.onunload,
    parseFloat: globalThis.parseFloat,
    parseInt: globalThis.parseInt,
    performance: globalThis.performance,
    Performance: globalThis.Performance,
    PerformanceEntry: globalThis.PerformanceEntry,
    PerformanceMark: globalThis.PerformanceMark,
    PerformanceMeasure: globalThis.PerformanceMeasure,
    process: globalThis.process,
    ProgressEvent: globalThis.ProgressEvent,
    Promise: globalThis.Promise,
    PromiseRejectionEvent: globalThis.PromiseRejectionEvent,
    prompt: globalThis.prompt,
    propertyIsEnumerable: globalThis.propertyIsEnumerable,
    Proxy: globalThis.Proxy,
    queueMicrotask: globalThis.queueMicrotask,
    RangeError: globalThis.RangeError,
    ReadableByteStreamController: globalThis.ReadableByteStreamController,
    ReadableStream: globalThis.ReadableStream,
    ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader,
    ReadableStreamBYOBRequest: globalThis.ReadableStreamBYOBRequest,
    ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
    ReadableStreamDefaultReader: globalThis.ReadableStreamDefaultReader,
    ReferenceError: globalThis.ReferenceError,
    Reflect: globalThis.Reflect,
    RegExp: globalThis.RegExp,
    removeEventListener: globalThis.removeEventListener,
    reportError: globalThis.reportError,
    Request: globalThis.Request,
    Response: globalThis.Response,
    self: globalThis.self,
    sessionStorage: globalThis.sessionStorage,
    Set: globalThis.Set,
    setImmediate: globalThis.setImmediate,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    SharedArrayBuffer: globalThis.SharedArrayBuffer,
    Storage: globalThis.Storage,
    String: globalThis.String,
    structuredClone: globalThis.structuredClone,
    SubtleCrypto: globalThis.SubtleCrypto,
    SuppressedError: globalThis.SuppressedError,
    Symbol: globalThis.Symbol,
    SyntaxError: globalThis.SyntaxError,
    TextDecoder: globalThis.TextDecoder,
    TextDecoderStream: globalThis.TextDecoderStream,
    TextEncoder: globalThis.TextEncoder,
    TextEncoderStream: globalThis.TextEncoderStream,
    toLocaleString: globalThis.toLocaleString,
    toString: globalThis.toString,
    TransformStream: globalThis.TransformStream,
    TransformStreamDefaultController: globalThis.TransformStreamDefaultController,
    TypeError: globalThis.TypeError,
    Uint16Array: globalThis.Uint16Array,
    Uint32Array: globalThis.Uint32Array,
    Uint8Array: globalThis.Uint8Array,
    Uint8ClampedArray: globalThis.Uint8ClampedArray,
    undefined: globalThis.undefined,
    unescape: globalThis.unescape,
    URIError: globalThis.URIError,
    URL: globalThis.URL,
    URLPattern: globalThis.URLPattern,
    URLSearchParams: globalThis.URLSearchParams,
    valueOf: globalThis.valueOf,
    WeakMap: globalThis.WeakMap,
    WeakRef: globalThis.WeakRef,
    WeakSet: globalThis.WeakSet,
    WebAssembly: globalThis.WebAssembly,
    WebSocket: globalThis.WebSocket,
    Window: globalThis.Window,
    Worker: globalThis.Worker,
    WritableStream: globalThis.WritableStream,
    WritableStreamDefaultController: globalThis.WritableStreamDefaultController,
    WritableStreamDefaultWriter: globalThis.WritableStreamDefaultWriter,
}