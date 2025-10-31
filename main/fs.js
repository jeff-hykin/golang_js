export class FS {
    constructor(options = {}) {
        this.encoder = new TextEncoder("utf-8");
        this.decoder = new TextDecoder("utf-8");

        this.filesystem = {};
        this.workingDirectory = "/";
        this.openFiles = new Map();
        this.nextFd = 1000;

        // Allow custom stdout/stderr per FS instance
        this.goStdout = options.goStdout || (() => {});
        this.goStderr = options.goStderr || (() => {});

        // Bind methods to preserve `this`
        this.writeSync = this.writeSync.bind(this);
        this.write = this.write.bind(this);
        this.open = this.open.bind(this);
        this.read = this.read.bind(this);
        this.close = this.close.bind(this);
        this.fsync = this.fsync.bind(this);
        this.unlink = this.unlink.bind(this);
        this.fstat = this.fstat.bind(this);
        this.stat = this.stat.bind(this);
        this.lstat = this.lstat.bind(this);
        this.fchmod = this.fchmod.bind(this);
    }

    absPath(path) {
        if (path[0] === "/") {
            return path;
        }
        return this.workingDirectory + path.replace(/^\.\//, "");
    }

    readFromGoFilesystem(path) {
        return this.filesystem[this.absPath(path)];
    }

    writeToGoFilesystem(path, content) {
        const abs = this.absPath(path);
        if (typeof content === "string") {
            this.filesystem[abs] = this.encoder.encode(content);
        } else {
            this.filesystem[abs] = content;
        }
    }

    get constants() {
        return {
            O_WRONLY: 1 << 0,
            O_RDWR: 1 << 1,
            O_CREAT: 1 << 2,
            O_TRUNC: 1 << 3,
            O_APPEND: 1 << 4,
            O_EXCL: 1 << 5,
        };
    }

    stat(path, callback) {
        let mode = 0;
        const abs = typeof path === "string" ? this.absPath(path) : path;

        if (abs === "/") {
            mode |= 0x80000000; // directory flag
        } else if (this.filesystem[abs] === undefined) {
            const err = new Error("no such file");
            err.code = "ENOENT";
            callback(err);
            return;
        }

        callback(null, {
            mode,
            dev: 0,
            ino: 0,
            nlink: 0,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: this.filesystem[abs]?.length || 0,
            blksize: 0,
            blocks: 0,
            atimeMs: 0,
            mtimeMs: 0,
            ctimeMs: 0,
            isDirectory: () => !!(mode & 0x80000000),
        });
    }

    writeSync(fd, buf) {
        if (fd === 1) {
            this.goStdout(buf);
            return buf.length;
        } else if (fd === 2) {
            this.goStderr(buf);
            return buf.length;
        }

        const file = this.openFiles.get(fd);
        if (!file) throw new Error("Bad file descriptor");

        const source = this.filesystem[file.path] || new Uint8Array(0);
        let destLength = source.length + buf.length;

        if (file.offset < source.length) {
            destLength = Math.max(file.offset + buf.length, source.length);
        }

        const dest = new Uint8Array(destLength);
        dest.set(source.subarray(0, source.length));
        dest.set(buf, file.offset);

        file.offset += buf.length;
        this.filesystem[file.path] = dest;

        return buf.length;
    }

    write(fd, buf, offset, length, position, callback) {
        if (offset !== 0 || length !== buf.length) {
            throw new Error("write not fully implemented: " + offset + ", " + length + "/" + buf.length);
        }
        if (position !== null) {
            const file = this.openFiles.get(fd);
            if (file) file.offset = position;
        }
        try {
            const written = this.writeSync(fd, buf);
            callback(null, written);
        } catch (err) {
            callback(err);
        }
    }

    open(path, flags, mode, callback) {
        const abs = this.absPath(path);
        let fileExists = !!this.filesystem[abs];

        if (!fileExists && (flags & this.constants.O_CREAT)) {
            this.filesystem[abs] = new Uint8Array(0);
            fileExists = true;
        } else if (!fileExists) {
            const err = new Error("no such file");
            err.code = "ENOENT";
            return callback(err);
        }

        if (flags & this.constants.O_TRUNC) {
            this.filesystem[abs] = new Uint8Array(0);
        }

        const fd = this.nextFd++;
        this.openFiles.set(fd, {
            offset: 0,
            path: abs,
        });

        callback(null, fd);
    }

    read(fd, buffer, offset, length, position, callback) {
        if (offset !== 0) {
            throw new Error("read not fully implemented: " + offset);
        }

        const file = this.openFiles.get(fd);
        if (!file) return callback(new Error("Bad file descriptor"));

        if (position !== null) {
            file.offset = position;
        }

        const source = this.filesystem[file.path] || new Uint8Array(0);
        let n = Math.min(length, source.length - file.offset);

        if (n > 0) {
            buffer.set(source.subarray(file.offset, file.offset + n), 0);
        }

        file.offset += n;
        callback(null, n);
    }

    close(fd, callback) {
        this.openFiles.delete(fd);
        callback(null);
    }

    fsync(fd, callback) {
        callback(null);
    }

    unlink(path, callback) {
        const abs = this.absPath(path);
        delete this.filesystem[abs];
        callback(null);
    }

    fstat(fd, callback) {
        const file = this.openFiles.get(fd);
        if (!file) return callback(new Error("Bad file descriptor"));
        this.stat(file.path, callback);
    }

    stat(path, callback) {
        this.stat(this.absPath(path), callback);
    }

    lstat(path, callback) {
        this.stat(this.absPath(path), callback);
    }

    fchmod(fd, mode, callback) {
        callback(null);
    }

    get cwd() {
        return this.workingDirectory;
    }

    set cwd(dir) {
        if (dir.endsWith("/")) {
            this.workingDirectory = dir;
        } else {
            this.workingDirectory = dir + "/";
        }
    }

    // Expose fs object compatible with original exports
    get fs() {
        return {
            constants: this.constants,
            writeSync: this.writeSync,
            write: this.write,
            open: this.open,
            read: this.read,
            close: this.close,
            fsync: this.fsync,
            unlink: this.unlink,
            fstat: this.fstat,
            stat: this.stat,
            lstat: this.lstat,
            fchmod: this.fchmod,
        };
    }

    get process() {
        return {
            cwd: () => this.cwd,
        };
    }

    // Optional: reset instance
    reset() {
        this.filesystem = {};
        this.openFiles.clear();
        this.nextFd = 1000;
        this.workingDirectory = "/";
    }
}