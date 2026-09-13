/** Lazy POSIX flock entry; importing it does not load a native addon. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
let binding;
/** Termux/Android: no prebuilt system.node, but bionic libc exposes flock(2) since API 24 — call it via the koffi FFI that dsh already ships. */
function loadAndroidBinding() {
    const require = createRequire(import.meta.url);
    const koffi = require('koffi');
    const libc = koffi.load('libc.so');
    const flock = libc.func('int flock(int fd, int op)');
    return {
        tryLock(fd, callback) {
            const result = flock(fd, 2 | 4 /* LOCK_EX | LOCK_NB */);
            callback(result === 0 ? 0 : koffi.errno());
        },
    };
}
function loadBinding() {
    if (binding)
        return binding;
    const { platform, arch } = process;
    if (platform === 'android') {
        binding = loadAndroidBinding();
        return binding;
    }
    if (platform !== 'linux' && platform !== 'darwin') {
        throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
            syscall: 'flock',
        });
    }
    let filename = 'system.node';
    if (platform === 'linux') {
        // Node's report types omit the libc field supplied by Linux reports.
        const report = process.report.getReport();
        filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename);
    }
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`);
    binding = require(join(dirname(manifest), 'bin', filename));
    return binding;
}
/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'. Native setup errors, unsupported
 *   platforms, and addon loading failures reject; importing alone does not load it.
 */
export async function tryLockExclusive(fd) {
    const errno = await new Promise((resolve) => {
        loadBinding().tryLock(fd, resolve);
    });
    if (errno === 0)
        return;
    const code = getSystemErrorName(-errno);
    throw Object.assign(new Error(`${code}: flock failed`), {
        code,
        errno,
        syscall: 'flock',
    });
}
