/**
 * Trusted Linux bootstrap, shipped in the reviewed helper archive. Python is
 * invoked with -I and an empty environment. This is deliberately independent of
 * the qualification fixture. Neither script accepts numeric signal recipients.
 */
export const LINUX_INNER_LAUNCHER = String.raw`
import array, ctypes, errno, json, os, re, select, signal, socket, stat, time
def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError('duplicate release field')
        result[key] = value
    return result
def release_binding(value):
    if (type(value) is not dict or set(value) != {'binding', 'incarnation'} or
            type(value['binding']) is not str or re.fullmatch('[a-f0-9]{64}', value['binding']) is None or
            type(value['incarnation']) is not str or re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['incarnation']) is None):
        raise RuntimeError('invalid release binding')
    return value
def validate_release(line, expected):
    if type(line) is not bytes or len(line) > 512:
        raise RuntimeError('invalid release message')
    value = json.loads(line, object_pairs_hook=unique_object)
    if (type(value) is not dict or set(value) != {'type', 'version', 'binding', 'incarnation', 'notAfterMonotonicNs'} or
            value['type'] != 'START' or type(value['version']) is not int or value['version'] != 1 or
            value['binding'] != expected['binding'] or value['incarnation'] != expected['incarnation'] or
            type(value['notAfterMonotonicNs']) is not str or re.fullmatch('[1-9][0-9]{0,18}', value['notAfterMonotonicNs']) is None or
            int(value['notAfterMonotonicNs']) > 9223372036854775807 or
            time.clock_gettime_ns(time.CLOCK_MONOTONIC) >= int(value['notAfterMonotonicNs'])):
        raise RuntimeError('invalid or expired release')
    return value
def receive_release(channel, expected):
    # Read exactly one frame without buffered read-ahead hiding SEAL/duplicates.
    line = b''
    while len(line) <= 512:
        data = channel.recv(1)
        if not data:
            raise RuntimeError('release channel closed')
        if data == b'\n':
            validate_release(line, expected)
            return line
        line += data
    raise RuntimeError('release message exceeded limit')
def final_admission(channel, line, expected):
    # Any queued control input, including EOF, seals this one-shot channel.
    if select.select([channel], [], [], 0)[0]:
        raise RuntimeError('release sealed or repeated before exec')
    validate_release(line, expected)
def launch_environment(launch, credentials):
    environment = launch['env']
    selection = launch.get('selectedLogin')
    if selection is not None:
        if (selection not in ('codex', 'claude') or credentials or
                environment.get('CODEX_HOME' if selection == 'codex' else 'CLAUDE_CONFIG_DIR') != '/work/.mdai-home/' + selection):
            raise RuntimeError('invalid selected login transport')
        if selection == 'claude':
            # Only the trusted launch record selects this fixed sandbox path.
            # Keep exact raw UTF-8 bytes: no host environment, shell or settings.
            descriptor = os.open('/work/.mdai-home/claude/oauth-token', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            try:
                info = os.fstat(descriptor)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                        stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or not 0 < info.st_size <= 16384):
                    raise RuntimeError('invalid selected login token')
                token_bytes = os.read(descriptor, 16385)
                if len(token_bytes) != info.st_size:
                    raise RuntimeError('invalid selected login token')
            finally:
                os.close(descriptor)
            token = token_bytes.decode('utf-8', errors='strict')
            if not token or len(token) > 16384 or re.search('[\\s\\x00-\\x1f\\x7f-\\x9f\\ufeff]', token):
                raise RuntimeError('invalid selected login token')
            environment['CLAUDE_CODE_OAUTH_TOKEN'] = token
    environment.update(credentials)
    return environment
def provider_environment(spec):
    digest = spec['closureDigest']
    return {'HOME': '/tmp/mdai-provider/home', 'TMPDIR': '/tmp/mdai-provider/tmp',
        'XDG_CACHE_HOME': '/tmp/mdai-provider/cache', 'PATH': '/usr/bin:/bin',
        'LD_LIBRARY_PATH': '/usr/local/lib/mdai/ollama/' + digest + '/lib/ollama',
        'OLLAMA_HOST': '127.0.0.1:11434', 'OLLAMA_MODELS': spec['modelsPath'],
        'OLLAMA_NOPRUNE': '1', 'OLLAMA_NO_CLOUD': '1', 'OLLAMA_NUM_PARALLEL': '1',
        'OLLAMA_MAX_LOADED_MODELS': '1', 'OLLAMA_MAX_QUEUE': '1',
        'OLLAMA_CONTEXT_LENGTH': '8192', 'OLLAMA_KEEP_ALIVE': '-1',
        'CUDA_VISIBLE_DEVICES': '-1', 'ROCR_VISIBLE_DEVICES': '-1'}
def verify_provider(spec):
    required = {'format', 'kind', 'version', 'executable', 'closureDigest', 'storeDigest', 'modelsPath',
        'upstreamModel', 'model', 'modelDigest', 'upstreamDigest', 'baseURL', 'parameters', 'resources',
        'files', 'directories', 'env', 'capabilities', 'upstreamManifest', 'policyManifest', 'providerCwd'}
    if (type(spec) is not dict or set(spec) != required or type(spec['format']) is not int or spec['format'] != 1 or
            spec['kind'] != 'ollama' or spec['version'] != '0.40.14' or
            spec['upstreamModel'] != 'qwen3:30b-a3b' or
            spec['model'] != 'mdai-qwen3:30b-a3b-ctx8192-cpu16' or
            spec['baseURL'] != 'http://127.0.0.1:11434/v1' or
            spec['parameters'] != {'num_thread': 16, 'num_ctx': 8192, 'num_gpu': 0} or
            any(type(value) is not int for value in spec['parameters'].values()) or
            spec['resources'] != {'cpuMax': '1600000 100000', 'memoryMax': 25000000000, 'memorySwapMax': 0, 'memoryOomGroup': 1} or
            spec['capabilities'] != ['completion', 'tools']):
        raise RuntimeError('invalid provider policy')
    for key in ('closureDigest', 'storeDigest'):
        if type(spec[key]) is not str or re.fullmatch('[a-f0-9]{64}', spec[key]) is None:
            raise RuntimeError('invalid provider inventory digest')
    for key in ('modelDigest', 'upstreamDigest'):
        if type(spec[key]) is not str or re.fullmatch('sha256:[a-f0-9]{64}', spec[key]) is None:
            raise RuntimeError('invalid provider manifest digest')
    closure = '/usr/local/lib/mdai/ollama/' + spec['closureDigest']
    store = '/usr/local/share/mdai/ollama/' + spec['storeDigest'] + '/models'
    if (spec['executable'] != closure + '/bin/ollama' or spec['modelsPath'] != store or
            spec['env'] != provider_environment(spec)):
        raise RuntimeError('invalid provider executable or environment')
    if (type(spec['files']) is not list or not 1 <= len(spec['files']) <= 4096 or
            type(spec['directories']) is not list or not 1 <= len(spec['directories']) <= 4096):
        raise RuntimeError('invalid provider inventory')
    inventory = '/usr/local/share/mdai/ollama/provider.json'
    seen = set()
    for directory, entries in ((False, spec['files']), (True, spec['directories'])):
        for entry in entries:
            fields = {'path', 'dev', 'ino', 'mtimeNs', 'ctimeNs'}
            if directory:
                fields.add('immutable')
            if not directory:
                fields |= {'sha256', 'size', 'executable'}
            if type(entry) is not dict or set(entry) != fields:
                raise RuntimeError('invalid provider inventory entry')
            path = entry['path']
            if (type(path) is not str or not (path.startswith(closure + '/') or path.startswith(store + '/') or
                    not directory and path == inventory or directory and
                    (path == '/' or closure.startswith(path + '/') or store.startswith(path + '/') or path in (closure, store))) or
                    path in seen or path != '/' and any(part in ('', '.', '..') for part in path.split('/')[1:])):
                raise RuntimeError('invalid provider inventory path')
            seen.add(path)
            if directory and path == '/':
                # bwrap constructed a different private root; /usr and its
                # retained source identities are the shared immutable boundary.
                continue
            info = os.stat(path, follow_symlinks=False)
            for key, actual in (('dev', info.st_dev), ('ino', info.st_ino),
                                ('mtimeNs', info.st_mtime_ns), ('ctimeNs', info.st_ctime_ns)):
                if type(entry[key]) is not str or (not directory or entry['immutable'] or key in ('dev', 'ino')) and entry[key] != str(actual):
                    raise RuntimeError('provider inventory identity changed')
            if directory:
                if (type(entry['immutable']) is not bool or not stat.S_ISDIR(info.st_mode) or
                        info.st_mode & 0o6022 or entry['immutable'] and stat.S_IMODE(info.st_mode) != 0o555):
                    raise RuntimeError('provider inventory directory changed')
            elif (type(entry['size']) is not int or entry['size'] != info.st_size or
                    type(entry['executable']) is not bool or not stat.S_ISREG(info.st_mode) or
                    stat.S_IMODE(info.st_mode) != (0o555 if entry['executable'] else 0o444) or
                    type(entry['sha256']) is not str or re.fullmatch('[a-f0-9]{64}', entry['sha256']) is None):
                raise RuntimeError('provider inventory file changed')
    # Full streaming hashes were verified before authorization. This second pass
    # binds every immutable inode to those digests without re-reading 19 GB in
    # the signed start window. All source paths are in the existing read-only /usr.
    for key, digest in (('policyManifest', spec['modelDigest']), ('upstreamManifest', spec['upstreamDigest'])):
        if not any(entry['path'] == spec[key] and entry['sha256'] == digest[7:] for entry in spec['files']):
            raise RuntimeError('provider manifest pin mismatch')
    for key in ('executable', 'upstreamManifest', 'policyManifest'):
        if spec[key] not in {entry['path'] for entry in spec['files']}:
            raise RuntimeError('provider executable or manifest missing from inventory')
    verify_provider_cwd(spec)
def verify_provider_cwd(spec, descriptor=None, entered=False):
    cwd = spec['providerCwd']
    path = '/usr/local/lib/mdai/ollama/' + spec['closureDigest'] + '/lib/ollama'
    if (type(cwd) is not dict or set(cwd) != {'path', 'contract', 'dev', 'ino'} or
            cwd['contract'] != 'ollama-inherited-cwd-v1' or cwd['path'] != path or
            any(type(cwd[key]) is not str or re.fullmatch('[0-9]+', cwd[key]) is None for key in ('dev', 'ino'))):
        raise RuntimeError('invalid provider cwd contract')
    directories = {entry['path']: entry for entry in spec['directories']}
    recorded = directories.get(path)
    root = directories.get('/usr')
    if (recorded is None or recorded['immutable'] is not True or root is None or
            any(recorded[key] != cwd[key] for key in ('dev', 'ino'))):
        raise RuntimeError('provider cwd missing from immutable inventory')
    # Host-root ownership was verified before the user namespace. Its UID may
    # be unmapped here, so bind to the owner of the retained /usr source inode.
    root_info = os.stat('/usr', follow_symlinks=False)
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_mode & 0o6022 or
            any(root[key] != str(actual) for key, actual in (('dev', root_info.st_dev), ('ino', root_info.st_ino)))):
        raise RuntimeError('provider cwd root identity changed')
    def check(info, entry, directory):
        if (info.st_uid != root_info.st_uid or
                not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) or
                stat.S_IMODE(info.st_mode) != (0o555 if directory or entry['executable'] else 0o444) or
                any(entry[key] != str(actual) for key, actual in (('dev', info.st_dev), ('ino', info.st_ino),
                    ('mtimeNs', info.st_mtime_ns), ('ctimeNs', info.st_ctime_ns)))):
            raise RuntimeError('provider cwd entry identity or ownership changed')
    if os.path.realpath(path) != path:
        raise RuntimeError('provider cwd realpath changed')
    check(os.stat(path, follow_symlinks=False), recorded, True)
    if descriptor is not None:
        check(os.fstat(descriptor), recorded, True)
    if entered:
        if descriptor is None or os.getcwd() != path:
            raise RuntimeError('provider inherited cwd changed')
        check(os.stat('.', follow_symlinks=False), recorded, True)
    expected = {os.path.basename(entry['path']): entry for entry in spec['files'] + spec['directories']
        if os.path.dirname(entry['path']) == path}
    names = os.listdir(path if descriptor is None else descriptor)
    if len(names) != len(expected) or set(names) != set(expected):
        raise RuntimeError('provider cwd entries changed')
    for name, entry in expected.items():
        info = os.stat(entry['path'], follow_symlinks=False) if descriptor is None else os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        check(info, entry, entry['path'] in directories)
def close_except(keep):
    begin = 3
    for descriptor in sorted(fd for fd in keep if fd >= 3):
        os.closerange(begin, descriptor)
        begin = descriptor + 1
    os.closerange(begin, 1048576)
def reset_provider_signals():
    for signum in signal.valid_signals():
        if signum not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(signum, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])
def provider_exec(spec, status, release, expected, log_write):
    # The monitor alone owns its status socket after provider exec. It and the
    # provider never retain the original workload proof fd or output writers.
    with open('/dev/null', 'rb', buffering=0) as quiet:
        os.dup2(quiet.fileno(), 0)
    os.dup2(log_write, 1)
    os.dup2(log_write, 2)
    close_except({status.fileno()})
    os.set_inheritable(status.fileno(), False)
    cwd = os.open(spec['providerCwd']['path'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        verify_provider_cwd(spec, cwd)
        os.fchdir(cwd)
        reset_provider_signals()
        verify_provider_cwd(spec, cwd, entered=True)
        final_admission(status, release, expected)
        os.execve(spec['executable'], [spec['executable'], 'serve'], provider_environment(spec))
    finally:
        os.close(cwd)
def provider_http(path, payload, check):
    # Fixed namespace-local HTTP only. No proxy environment, redirects, unbounded
    # buffering, background requests, or blocking socket read can bypass checks.
    body = b'' if payload is None else json.dumps(payload, separators=(',', ':')).encode()
    request = (('GET' if payload is None else 'POST') + ' ' + path + ' HTTP/1.1\r\n'
        'Host: 127.0.0.1:11434\r\nConnection: close\r\nContent-Type: application/json\r\n'
        'Content-Length: ' + str(len(body)) + '\r\n\r\n').encode() + body
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.setblocking(False)
        code = connection.connect_ex(('127.0.0.1', 11434))
        if code not in (0, errno.EINPROGRESS, errno.EWOULDBLOCK):
            raise OSError(code, 'provider connect failed')
        sent, response = 0, bytearray()
        while True:
            check()
            readable, writable, _ = select.select([connection] if sent == len(request) else [],
                [connection] if sent < len(request) else [], [], 0.05)
            if writable:
                code = connection.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                if code:
                    raise OSError(code, 'provider connect failed')
                try:
                    sent += connection.send(request[sent:])
                except BlockingIOError:
                    pass
            if readable:
                try:
                    chunk = connection.recv(8192)
                except BlockingIOError:
                    continue
                if not chunk:
                    break
                response.extend(chunk)
                if len(response) > 139264 or b'\r\n\r\n' not in response and len(response) > 8192:
                    raise RuntimeError('provider HTTP response exceeded limit')
        check()
    header, separator, encoded = bytes(response).partition(b'\r\n\r\n')
    lines = header.split(b'\r\n')
    if not separator or len(header) > 8192 or lines[0] not in (b'HTTP/1.1 200 OK', b'HTTP/1.0 200 OK'):
        raise RuntimeError('provider HTTP status failed')
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b':')
        name = name.lower()
        if not colon or name in headers:
            raise RuntimeError('invalid provider HTTP headers')
        headers[name] = value.strip()
    if b'transfer-encoding' in headers:
        if headers[b'transfer-encoding'] != b'chunked' or b'content-length' in headers:
            raise RuntimeError('invalid provider HTTP encoding')
        decoded = bytearray()
        while True:
            length, separator, encoded = encoded.partition(b'\r\n')
            if not separator or re.fullmatch(b'[a-fA-F0-9]{1,8}', length) is None:
                raise RuntimeError('invalid provider HTTP chunk')
            count = int(length, 16)
            if count == 0:
                if encoded != b'\r\n':
                    raise RuntimeError('invalid provider HTTP trailer')
                break
            if len(encoded) < count + 2 or encoded[count:count + 2] != b'\r\n':
                raise RuntimeError('invalid provider HTTP chunk')
            decoded.extend(encoded[:count])
            encoded = encoded[count + 2:]
            if len(decoded) > 131072:
                raise RuntimeError('provider HTTP body exceeded limit')
        encoded = bytes(decoded)
    elif b'content-length' not in headers or headers[b'content-length'] != str(len(encoded)).encode():
        raise RuntimeError('invalid provider HTTP length')
    if len(encoded) > 131072:
        raise RuntimeError('provider HTTP body exceeded limit')
    value = json.loads(encoded, object_pairs_hook=unique_object)
    if type(value) is not dict:
        raise RuntimeError('invalid provider HTTP JSON')
    return value

def provider_readiness(spec, request, check, pause):
    while True:
        check()
        try:
            version = request('/api/version', None)
            break
        except (ConnectionRefusedError, ConnectionResetError):
            pause()
    if version != {'version': spec['version']}:
        raise RuntimeError('provider API version mismatch')
    tags = request('/api/tags', None).get('models')
    if type(tags) is not list or not 1 <= len(tags) <= 2:
        raise RuntimeError('provider model tags mismatch')
    names = set()
    expected = {spec['model']: spec['modelDigest'], spec['upstreamModel']: spec['upstreamDigest']}
    for tag in tags:
        if (type(tag) is not dict or tag.get('name') not in expected or tag.get('name') in names or
                tag.get('model') != tag.get('name') or tag.get('digest') not in (expected[tag['name']], expected[tag['name']][7:])):
            raise RuntimeError('provider model digest mismatch')
        names.add(tag['name'])
    if spec['model'] not in names:
        raise RuntimeError('provider policy model missing')
    shown = request('/api/show', {'model': spec['model']})
    capabilities = shown.get('capabilities')
    if type(capabilities) is not list or sorted(capabilities) != spec['capabilities']:
        raise RuntimeError('provider capabilities mismatch')
    parameters = shown.get('parameters')
    if type(parameters) is not str or len(parameters) > 16384:
        raise RuntimeError('provider parameters missing')
    selected = {}
    for line in parameters.splitlines():
        fields = line.split()
        if fields and fields[0] in spec['parameters']:
            if len(fields) != 2 or fields[0] in selected or not fields[1].isdigit():
                raise RuntimeError('provider parameters mismatch')
            selected[fields[0]] = int(fields[1])
    if selected != spec['parameters']:
        raise RuntimeError('provider parameters mismatch')
    options = {**spec['parameters'], 'num_predict': 1}
    loaded = request('/api/generate', {'model': spec['model'], 'prompt': '', 'stream': False,
        'keep_alive': -1, 'options': options})
    if loaded.get('model') != spec['model'] or loaded.get('done') is not True or loaded.get('error') is not None:
        raise RuntimeError('provider model loading failed')
    generated = request('/api/generate', {'model': spec['model'], 'prompt': 'Reply with one word: ready',
        'stream': False, 'keep_alive': -1, 'options': options})
    if (generated.get('model') != spec['model'] or generated.get('done') is not True or
            generated.get('error') is not None or type(generated.get('eval_count')) is not int or
            generated['eval_count'] != 1 or type(generated.get('response')) is not str):
        raise RuntimeError('provider one-token generation failed')
    running = request('/api/ps', None).get('models')
    if (type(running) is not list or len(running) != 1 or type(running[0]) is not dict or
            running[0].get('name') != spec['model'] or running[0].get('model') != spec['model'] or
            running[0].get('digest') not in (spec['modelDigest'], spec['modelDigest'][7:]) or running[0].get('context_length') != 8192 or
            type(running[0].get('size_vram')) is not int or running[0]['size_vram'] != 0):
        raise RuntimeError('provider loaded model placement mismatch')
    check()
def drain_provider_logs(log_read, log_file, state):
    for _ in range(8):
        try:
            chunk = os.read(log_read, 8192)
        except BlockingIOError:
            break
        if not chunk:
            break
        state['tail'] = (state['tail'] + chunk)[-2048:]
        remaining = 65536 - state['written']
        if remaining > 0:
            state['written'] += os.write(log_file, chunk[:remaining])
def monitor_provider(spec, status, readiness, workload_task, release, expected):
    provider_task = None
    try:
        # No duplicated workload descriptors survive in the trusted monitor.
        with open('/dev/null', 'r+b', buffering=0) as quiet:
            for descriptor in (0, 1, 2):
                os.dup2(quiet.fileno(), descriptor)
        close_except({status.fileno(), readiness.fileno(), workload_task})
        if libc.prctl(4, 0, 0, 0, 0) != 0:
            raise RuntimeError('provider monitor protection failed')
        reset_provider_signals()
        status.setblocking(False)
        readiness.setblocking(False)
        os.mkdir('/tmp/mdai-provider', 0o700)
        for name in ('home', 'tmp', 'cache'):
            os.mkdir('/tmp/mdai-provider/' + name, 0o700)
        log_file = os.open('/tmp/mdai-provider/diagnostics.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        log_read, log_write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
        os.set_blocking(log_write, True)
        final_admission(status, release, expected)
        child = os.fork()
        if child == 0:
            try:
                provider_exec(spec, status, release, expected, log_write)
            except BaseException:
                os._exit(127)
        provider_task = os.pidfd_open(child, 0)
        os.close(log_write)
        logs = {'tail': b'', 'written': 0}
        def check(starting=True):
            drain_provider_logs(log_read, log_file, logs)
            if select.select([workload_task], [], [], 0)[0]:
                raise RuntimeError('workload-exited')
            if select.select([provider_task], [], [], 0)[0]:
                raise RuntimeError('provider-exited')
            if starting:
                final_admission(status, release, expected)
            elif select.select([status], [], [], 0)[0]:
                raise RuntimeError('provider-sealed')
        provider_readiness(spec, lambda path, value: provider_http(path, value, check), check,
                           lambda: select.select([status, provider_task, workload_task], [], [], 0.05))
        status.sendall(b'{"event":"provider-ready"}\n')
        readiness.sendmsg([b'READY\n'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [provider_task]))])
        while True:
            check(False)
            select.select([status, provider_task, workload_task, log_read], [], [], 0.05)
    except BaseException as error:
        reason = str(error)
        event = {'event': 'workload-exited'} if reason == 'workload-exited' else {'event': 'provider-failed'}
        try:
            status.sendall((json.dumps(event, separators=(',', ':')) + '\n').encode())
        except BaseException:
            pass
    finally:
        if provider_task is not None:
            try:
                # Exact retained process identity, never a sampled numeric PID.
                signal.pidfd_send_signal(provider_task, signal.SIGKILL, None, 0)
            except ProcessLookupError:
                pass
        os._exit(0)
def receive_monitor_registration(channel, status, release, expected):
    # Consume only the acknowledgement, before fork. Thereafter no reader ever
    # consumes this socket: queued cancellation/EOF is one persistent state
    # shared by the launcher, monitor and provider, including their exec checks.
    acknowledgement = b'REGISTERED\n'
    received = b''
    status.setblocking(False)
    while received != acknowledgement:
        final_admission(channel, release, expected)
        if not select.select([status], [], [], 0.05)[0]:
            continue
        chunk = status.recv(1)
        received += chunk
        if not chunk or not acknowledgement.startswith(received):
            raise RuntimeError('provider monitor registration refused')
    final_admission(channel, release, expected)
    final_admission(status, release, expected)
def start_provider(spec, channel, release, expected):
    verify_provider(spec)
    final_admission(channel, release, expected)
    status, outer = socket.socketpair()
    readiness, monitor_readiness = socket.socketpair()
    workload_task = os.pidfd_open(os.getpid(), 0)
    # Registration happens only after RELEASE. The guardian must acknowledge
    # the new channel before any fork; a descriptor sent is not yet registered.
    try:
        channel.sendmsg([b'{"event":"provider-monitor"}\n'],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [outer.fileno()]))])
        outer.close()
        receive_monitor_registration(channel, status, release, expected)
        monitor = os.fork()
    except BaseException:
        outer.close()
        status.close()
        readiness.close()
        monitor_readiness.close()
        os.close(workload_task)
        raise
    if monitor == 0:
        monitor_provider(spec, status, monitor_readiness, workload_task, release, expected)
        os._exit(127)
    monitor_task = os.pidfd_open(monitor, 0)
    monitor_readiness.close()
    os.close(workload_task)
    data, descriptors = b'', []
    try:
        while b'\n' not in data:
            final_admission(channel, release, expected)
            final_admission(status, release, expected)
            if select.select([monitor_task], [], [], 0)[0]:
                raise RuntimeError('provider monitor exited before readiness')
            if not select.select([readiness], [], [], 0.05)[0]:
                continue
            chunk, ancillary, flags, _ = readiness.recvmsg(64, socket.CMSG_SPACE(array.array('i').itemsize))
            if not chunk or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                raise RuntimeError('provider readiness channel failed')
            data += chunk
            for level, tag, payload in ancillary:
                if level != socket.SOL_SOCKET or tag != socket.SCM_RIGHTS:
                    raise RuntimeError('invalid provider readiness descriptor')
                received = array.array('i')
                received.frombytes(payload)
                descriptors.extend(received)
            if len(data) > 64 or len(descriptors) > 1:
                raise RuntimeError('invalid provider readiness frame')
        if data != b'READY\n' or len(descriptors) != 1:
            raise RuntimeError('invalid provider readiness frame')
        final_admission(channel, release, expected)
        final_admission(status, release, expected)
        # Preserve these exact identities until the original task execs OpenCode.
        # Cancellation remains shared until exec. The workload inherits none of
        # these pidfds, readiness or cancellation descriptors.
        return [monitor_task, descriptors.pop(), readiness.detach(), status.detach()]
    except BaseException:
        status.close()
        os.close(monitor_task)
        for descriptor in descriptors:
            os.close(descriptor)
        readiness.close()
        raise
def provider_final_admission(descriptors):
    if select.select(descriptors, [], [], 0)[0]:
        raise RuntimeError('provider or monitor exited before workload exec')

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(38, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'PR_SET_NO_NEW_PRIVS')
# bubblewrap's monitor and PID 1 retain standard input. Use that inherited
# socket only to register a NEW private pair, born here after bwrap's forks.
# Its peer has no monitor duplicates, so CLOEXEC EOF can prove workload exec.
os.dup2(0, 3, inheritable=False)
os.close(0)
bootstrap = socket.socket(fileno=3)
inner_peer, guardian_peer = socket.socketpair()
# These descriptors identify namespaces created by this exact bwrap instance.
# They never reach the workload or get reconstructed from a sampled PID.
namespace_fds = array.array('i', [os.open('/proc/self/ns/net', os.O_RDONLY),
                               os.open('/proc/self/stat', os.O_RDONLY | os.O_CLOEXEC)])
bootstrap.sendmsg([b'{"event":"namespaces"}\n'],
                  [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [*namespace_fds, guardian_peer.fileno()]))])
for fd in namespace_fds:
    os.close(fd)
guardian_peer.close()
bootstrap.close()
os.dup2(inner_peer.fileno(), 3, inheritable=False)
inner_peer.close()
channel = socket.socket(fileno=3)
network = b''
input_fds = []
while b'\n' not in network:
    data, ancillary, flags, _ = channel.recvmsg(512, socket.CMSG_SPACE(array.array('i').itemsize))
    if not data or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
        raise RuntimeError('missing or truncated workload stdin registration')
    for level, tag, payload in ancillary:
        if level != socket.SOL_SOCKET or tag != socket.SCM_RIGHTS:
            raise RuntimeError('unexpected workload stdin registration')
        received = array.array('i')
        received.frombytes(payload)
        input_fds.extend(received)
    network += data
    if len(network) > 512 or len(input_fds) > 1:
        raise RuntimeError('invalid workload stdin registration')
if not network.startswith(b'NETWORK ') or not network.endswith(b'\n') or network.count(b'\n') != 1 or len(input_fds) != 1:
    raise RuntimeError('invalid workload stdin registration')
expected_release = release_binding(json.loads(network[8:-1], object_pairs_hook=unique_object))
os.dup2(input_fds[0], 0)
os.set_inheritable(0, True)
if input_fds[0] != 0:
    os.close(input_fds[0])
# --config-net must have brought up an interface in OUR private namespace.
limit = time.monotonic() + 10
while len(socket.if_nameindex()) < 2:
    if time.monotonic() >= limit:
        raise RuntimeError('pasta did not configure the workload network')
    time.sleep(0.01)
channel.sendall(b'{"event":"ready"}\n')
release_line = receive_release(channel, expected_release)
with open('/etc/mdai-launch.json', encoding='utf-8') as source:
    launch = json.load(source)
with open('/etc/mdai-credentials.json', encoding='utf-8') as source:
    credentials = json.load(source)
environment = launch_environment(launch, credentials)
provider_descriptors = None
if launch.get('provider') is not None:
    if credentials or launch.get('selectedLogin') is not None:
        raise RuntimeError('provider launch cannot carry credentials')
    provider_descriptors = start_provider(launch['provider'], channel, release_line, expected_release)
# CLOEXEC closes the private channel atomically before any workload instruction.
# Keeping it until exec allows a precise failure report when exec itself fails.
os.set_inheritable(3, False)
if provider_descriptors is None:
    os.closerange(4, 1048576)
else:
    close_except({3, *provider_descriptors})
    for descriptor in provider_descriptors:
        os.set_inheritable(descriptor, False)
os.chdir(launch['cwd'])
final_admission(channel, release_line, expected_release)
failure_marker = b'!'
try:
    # No Python signal handler or inherited ignore may survive admission. Exec
    # preserves SIG_DFL and the signal mask, so unblock everything before it.
    for signum in signal.valid_signals():
        if signum not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(signum, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])
    channel.sendall(b'{"event":"admitting"}\n')
    # This is the final native admission point. There is no blocking filesystem
    # operation after the last CLOCK_MONOTONIC and pending-seal checks.
    if launch.get('provider') is not None:
        provider_final_admission(provider_descriptors)
    final_admission(channel, release_line, expected_release)
    try:
        os.execve(launch['file'], [launch['file']] + launch['args'], environment)
    except OSError:
        # Only an operating-system error from exec itself proves a launch failure.
        failure_marker = b'X'
        raise
except BaseException:
    try:
        # An unframed failure byte prevents EOF from proving exec. Even if the
        # write fails, only kernel exit may close the proof descriptor here.
        os.write(3, failure_marker)
    except BaseException:
        pass
    finally:
        os._exit(127)
`;

export const LINUX_GUARDIAN = String.raw`
import array, ctypes, fcntl, json, os, re, selectors, signal, socket, subprocess, sys, time
def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError('duplicate release field')
        result[key] = value
    return result
def release_binding(value):
    if (type(value) is not dict or set(value) != {'binding', 'incarnation'} or
            type(value['binding']) is not str or re.fullmatch('[a-f0-9]{64}', value['binding']) is None or
            type(value['incarnation']) is not str or re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['incarnation']) is None):
        raise RuntimeError('invalid release binding')
    return value
def validate_release(line, expected):
    if type(line) is not bytes or len(line) > 512:
        raise RuntimeError('invalid release message')
    value = json.loads(line, object_pairs_hook=unique_object)
    if (type(value) is not dict or set(value) != {'type', 'version', 'binding', 'incarnation', 'notAfterMonotonicNs'} or
            value['type'] != 'START' or type(value['version']) is not int or value['version'] != 1 or
            value['binding'] != expected['binding'] or value['incarnation'] != expected['incarnation'] or
            type(value['notAfterMonotonicNs']) is not str or re.fullmatch('[1-9][0-9]{0,18}', value['notAfterMonotonicNs']) is None or
            int(value['notAfterMonotonicNs']) > 9223372036854775807 or
            time.clock_gettime_ns(time.CLOCK_MONOTONIC) >= int(value['notAfterMonotonicNs'])):
        raise RuntimeError('invalid or expired release')
    return value
def netns_owner_userns(netns_fd, controller_userns_fd):
    # nsfs ioctls return CLOEXEC descriptors. With --disable-userns, bwrap's
    # task userns is nested BELOW the userns that owns its network namespace.
    # Only the retained netns may select the userns handed to pasta.
    if fcntl.ioctl(netns_fd, 0xb703) != 0x40000000:  # NS_GET_NSTYPE, CLONE_NEWNET
        raise RuntimeError('bootstrap descriptor is not a network namespace')
    owner = fcntl.ioctl(netns_fd, 0xb701)  # NS_GET_USERNS
    try:
        parent = fcntl.ioctl(owner, 0xb702)  # NS_GET_PARENT
        try:
            actual, expected = os.fstat(parent), os.fstat(controller_userns_fd)
            if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
                raise RuntimeError('network namespace owner parent is not the controller user namespace')
        finally:
            os.close(parent)
        return owner
    except BaseException:
        os.close(owner)
        raise
os.umask(0o077)
libc = ctypes.CDLL(None, use_errno=True)
for option, value in ((38, 1), (4, 0)):  # NO_NEW_PRIVS, DUMPABLE
    if libc.prctl(option, value, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'guardian prctl')
# Node creates a fresh session for this spawn. Never leave its original group.
if os.getpid() != os.getpgrp() or os.getsid(0) != os.getpid():
    raise RuntimeError('guardian original session is not private')
original_group = os.getpgrp()
run_path, bwrap, args_json, pasta, binding_json = sys.argv[1:]
expected_release = release_binding(json.loads(binding_json, object_pairs_hook=unique_object))
if run_path.rsplit('/', 1)[-1] != 'run-' + expected_release['incarnation']:
    raise RuntimeError('release incarnation does not name reserved run')
os.write(3, b'0\n')
os.close(3)
with open('/proc/self/cgroup', encoding='ascii') as source:
    if source.read().strip() != '0::' + run_path:
        raise RuntimeError('guardian did not enter its reserved cgroup')
# Caught dispositions reset at exec, so tools and pasta receive normal TERM.
signal.signal(signal.SIGTERM, lambda *_: None)
control = socket.socket(fileno=4)
control.setblocking(False)
local, peer = socket.socketpair()
# The guardian inherits the controller's userns and never changes it. Pin that
# identity before spawning bwrap; neither this fd nor control crosses bwrap.
controller_userns_fd = os.open('/proc/self/ns/user', os.O_RDONLY | os.O_CLOEXEC)
# Only fd0 crosses bwrap as the bootstrap registration channel. The inner
# transfers a fresh private channel before original stdin or START is sent.
# close_fds excludes control fd4 and every controller management descriptor.
work = subprocess.Popen([bwrap] + json.loads(args_json), env={}, cwd='/',
                        stdin=peer, close_fds=True)
# Only workload-side writers may hold the controller's output pipes open.
# Retain fd1/fd2 on /dev/null so later private descriptors cannot reuse them.
# The controller can then observe EOF before authorizing guardian teardown.
with open('/dev/null', 'wb', buffering=0) as quiet_output:
    os.dup2(quiet_output.fileno(), 1)
    os.dup2(quiet_output.fileno(), 2)
peer.close()
local.setblocking(False)
selector = selectors.DefaultSelector()
selector.register(control, selectors.EVENT_READ, 'controller')
selector.register(local, selectors.EVENT_READ, 'sandbox')
buffers = {'controller': b'', 'sandbox': b'', 'monitor': b''}
monitor = None
monitor_fds = []
monitor_ready = False
monitor_terminal = False
monitor_closed = False
sealed = False
started = False
admission_pending = False
sandbox_closed = False
ready = False
terminated = False
reported_exit = False
bridge = None
bridge_stderr = b''
ns_fds = []
bootstrap_stat = None
def exec_proven():
    global bootstrap_stat
    if bootstrap_stat is None:
        return False
    try:
        # Read this retained proc inode only AFTER CLOEXEC EOF, never a sampled
        # PID or an earlier cached stat. Linux sets PF_EXITING before exit_files
        # closes the channel, even before bwrap/poll can observe child death.
        # After admitting, the inner can only exec or exit in the kernel, never
        # close this proof channel through Python interpreter finalization.
        # Thus EOF with a non-exiting exact task proves the exec boundary was
        # crossed. A fast exit without this proof is deliberately not started.
        stat = os.read(bootstrap_stat, 4096)
        fields = stat.rsplit(b') ', 1)[1].split()
        return (len(stat) < 4096 and len(fields) >= 50 and
                fields[0] in (b'R', b'S', b'D', b'T', b't', b'I') and
                fields[6].isdigit() and not int(fields[6]) & 0x00000004)
    except (OSError, IndexError, ValueError):
        return False
    finally:
        try:
            os.close(bootstrap_stat)
        except OSError:
            pass
        bootstrap_stat = None
def drain_bridge_stderr():
    global bridge_stderr
    if bridge.stderr.closed:
        return
    # A noisy bridge cannot fill its pipe or monopolize the control loop. Keep
    # only a small diagnostic tail, never on the workload's output descriptors.
    for _ in range(8):
        try:
            data = os.read(bridge.stderr.fileno(), 8192)
        except BlockingIOError:
            return
        if not data:
            selector.unregister(bridge.stderr)
            bridge.stderr.close()
            return
        # Even worst-case JSON escaping of this tail fits the 16 KiB private
        # response limit enforced by the controller.
        bridge_stderr = (bridge_stderr + data)[-2048:]
def report_bridge_failure():
    drain_bridge_stderr()
    report({'event': 'network-failed', 'diagnostics': bridge_stderr.decode('utf-8', errors='replace')})
def report(event):
    try:
        control.sendall((json.dumps(event, separators=(',', ':')) + '\n').encode())
    except (BrokenPipeError, ConnectionResetError, BlockingIOError, OSError):
        seal()
def seal():
    global sealed
    if not sealed:
        if monitor is not None:
            try:
                monitor.sendall(b'SEAL\n')
            except (BrokenPipeError, ConnectionResetError, BlockingIOError, OSError):
                pass
        try:
            local.sendall(b'SEAL\n')
        except (BrokenPipeError, ConnectionResetError, BlockingIOError, OSError):
            pass
    sealed = True
def signal_if_still_owned():
    if os.getpgrp() != original_group or original_group != os.getpid() or os.getsid(0) != os.getpid():
        raise RuntimeError('guardian original group changed')
    os.kill(0, signal.SIGTERM)
def terminate():
    global terminated
    seal()
    if terminated:
        return
    terminated = True
    signal_if_still_owned()
def disconnect():
    terminate()
    try:
        selector.unregister(control)
    except KeyError:
        pass
def controller_command(line):
    global started
    if line == b'SEAL':
        seal()
        report({'event': 'sealed'})
    elif line == b'TERM':
        terminate()
        report({'event': 'terminated'})
    else:
        try:
            if not ready or sealed or started:
                raise RuntimeError('guardian invalid or repeated admission')
            validate_release(line, expected_release)
            started = True
            local.sendall(line + b'\n')
        except (ValueError, TypeError, RuntimeError, OSError) as error:
            terminate()
            raise RuntimeError('guardian invalid or repeated admission') from error
def register_monitor():
    global monitor
    if not started or monitor is not None or len(monitor_fds) != 1:
        raise RuntimeError('invalid provider monitor registration')
    monitor = socket.socket(fileno=monitor_fds.pop())
    if (monitor.family != socket.AF_UNIX or
            monitor.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM):
        raise RuntimeError('invalid provider monitor channel')
    monitor.setblocking(False)
    selector.register(monitor, selectors.EVENT_READ, 'monitor')
    # Selector ordering cannot let handoff overtake queued controller input.
    # Partial input is also a refusal: after START no command can grant another
    # admission. sealed is authoritative even when set before this fd arrived.
    try:
        data = control.recv(8192)
    except BlockingIOError:
        data = None
    except (ConnectionResetError, BrokenPipeError):
        data = b''
    if data == b'':
        disconnect()
    elif data:
        buffers['controller'] += data
    if len(buffers['controller']) > 16384:
        raise RuntimeError('guardian command exceeded limit')
    while b'\n' in buffers['controller']:
        line, buffers['controller'] = buffers['controller'].split(b'\n', 1)
        controller_command(line)
    if buffers['controller']:
        seal()
    monitor.sendall(b'SEAL\n' if sealed else b'REGISTERED\n')
def monitor_command(line):
    global monitor_ready, monitor_terminal
    event = json.loads(line, object_pairs_hook=unique_object)
    if event == {'event': 'provider-ready'} and not monitor_ready and not monitor_terminal and not sealed:
        monitor_ready = True
        report(event)
    elif event == {'event': 'provider-failed'} and not monitor_terminal:
        monitor_terminal = True
        seal()
        report(event)
    elif event == {'event': 'workload-exited'} and monitor_ready and not monitor_terminal:
        monitor_terminal = True
        # The exact workload pidfd woke the monitor. Its provider child is
        # stopped and the monitor exits, allowing bwrap to return OpenCode's
        # authoritative status. The controller bounds this wait before cleanup.
        report(event)
    else:
        raise RuntimeError('invalid or repeated provider monitor report')
def monitor_disconnected():
    global monitor_closed
    if monitor_closed:
        return
    monitor_closed = True
    selector.unregister(monitor)
    if buffers['monitor'] or not monitor_terminal and not sealed:
        seal()
        report({'event': 'provider-monitor-failed'})
def drain_monitor():
    if monitor is None or monitor_closed:
        return
    try:
        data = monitor.recv(1024)
    except BlockingIOError:
        return
    except (BrokenPipeError, ConnectionResetError):
        data = b''
    if not data:
        monitor_disconnected()
        return
    buffers['monitor'] += data
    if len(buffers['monitor']) > 512:
        raise RuntimeError('provider monitor report exceeded limit')
    while b'\n' in buffers['monitor']:
        line, buffers['monitor'] = buffers['monitor'].split(b'\n', 1)
        monitor_command(line)

def sandbox_disconnected():
    global admission_pending, sandbox_closed
    if sandbox_closed:
        return
    sandbox_closed = True
    # Consume already-published failure before accepting the exec proof.
    drain_monitor()
    proven = exec_proven()
    # The inner reports errors before closing. EOF alone also occurs on death;
    # only an unsealed admission with positive exec proof may report a start.
    # EOF is never emptiness evidence or permission to retire the run.
    if buffers['sandbox']:
        exec_failed = buffers['sandbox'] == b'X' and admission_pending and started and not sealed
        seal()
        report({'event': 'exec-error' if exec_failed else 'tool-error'})
        return
    if admission_pending and not sealed:
        admission_pending = False
        if proven:
            report({'event': 'started'})
        else:
            seal()
            report({'event': 'tool-error'})
    elif not sealed:
        seal()
        report({'event': 'tool-error'})
while True:
    for key, _ in selector.select(0.05):
        kind = key.data
        if kind == 'monitor':
            drain_monitor()
            continue
        if kind == 'pasta':
            drain_bridge_stderr()
            continue
        try:
            if kind == 'sandbox':
                data, ancillary, flags, _ = local.recvmsg(8192, socket.CMSG_SPACE(3 * array.array('i').itemsize))
                if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
                    raise RuntimeError('truncated namespace registration')
                for level, tag, payload in ancillary:
                    if level != socket.SOL_SOCKET or tag != socket.SCM_RIGHTS:
                        raise RuntimeError('unexpected namespace registration')
                    received = array.array('i')
                    received.frombytes(payload)
                    if bridge is None:
                        ns_fds.extend(received)
                    else:
                        monitor_fds.extend(received)
                        if len(monitor_fds) > 1:
                            raise RuntimeError('invalid provider monitor registration')
            else:
                data = key.fileobj.recv(8192)
        except BlockingIOError:
            # Monitor registration may already have drained this event from
            # the current selector snapshot before acknowledging the handoff.
            continue
        except (ConnectionResetError, BrokenPipeError):
            data = b''
        if not data:
            if kind == 'controller':
                disconnect()
            else:
                selector.unregister(key.fileobj)
                sandbox_disconnected()
            continue
        buffers[kind] += data
        if len(buffers[kind]) > 16384:
            raise RuntimeError('guardian command exceeded limit')
        while b'\n' in buffers[kind]:
            line, buffers[kind] = buffers[kind].split(b'\n', 1)
            if kind == 'controller':
                controller_command(line)
            else:
                event = json.loads(line)
                if event == {'event': 'namespaces'} and bridge is None and len(ns_fds) == 3:
                    if buffers['sandbox']:
                        raise RuntimeError('unexpected bootstrap channel data')
                    # bwrap's monitor/init retain the original stdin socket.
                    # Only this inner-created peer may carry release and exec
                    # proof; retire the inherited registration socket now.
                    private = socket.socket(fileno=ns_fds.pop())
                    try:
                        if (private.family != socket.AF_UNIX or
                                private.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM):
                            raise RuntimeError('invalid private admission channel')
                        private.setblocking(False)
                        selector.unregister(local)
                        local.close()
                        local = private
                        selector.register(local, selectors.EVENT_READ, 'sandbox')
                    except BaseException:
                        private.close()
                        raise
                    # The unread read-only stat descriptor pins the bootstrap
                    # task. It grants neither signal nor cleanup authority and
                    # is excluded from pasta's explicit pass_fds below.
                    bootstrap_stat = ns_fds.pop()
                    # pasta joins retained namespace descriptors. No PID lookup,
                    # host networking, forwarding ports or host-gateway mapping.
                    try:
                        ns_fds.append(netns_owner_userns(ns_fds[0], controller_userns_fd))
                        bridge = subprocess.Popen([pasta, '--foreground', '--config-net', '--no-map-gw',
                            '-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none',
                            '--dns-forward', '169.254.1.1',
                            '--netns', '/proc/self/fd/' + str(ns_fds[0]),
                            '--userns', '/proc/self/fd/' + str(ns_fds[1])],
                            env={}, cwd='/', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            close_fds=True, pass_fds=tuple(ns_fds))
                        os.set_blocking(bridge.stderr.fileno(), False)
                        selector.register(bridge.stderr, selectors.EVENT_READ, 'pasta')
                    finally:
                        for fd in ns_fds:
                            os.close(fd)
                        ns_fds = []
                        os.close(controller_userns_fd)
                    local.sendmsg([b'NETWORK ' + json.dumps(expected_release, separators=(',', ':')).encode() + b'\n'],
                                  [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [0]))])
                elif event == {'event': 'ready'} and bridge is not None and not ready and not sealed:
                    if bridge.poll() is not None:
                        report_bridge_failure()
                        raise RuntimeError('pasta exited before readiness')
                    ready = True
                    report({'event': 'ready'})
                elif event == {'event': 'provider-monitor'}:
                    register_monitor()
                elif event == {'event': 'admitting'} and started and not admission_pending and not sealed:
                    admission_pending = True
                elif event == {'event': 'tool-error'} and started:
                    seal()
                    report({'event': 'tool-error'})
                else:
                    raise RuntimeError('invalid sandbox bootstrap report')
    result = work.poll()
    # Drain the private admission channel before publishing a fast tool exit.
    # Its complete error frame or truncated tail must beat any start report.
    # A successful exec may close this channel just after the admitting frame
    # was read, with work.poll() already observing the tool's immediate exit.
    if result is not None and not reported_exit and sandbox_closed:
        reported_exit = True
        seal()
        report({'event': 'exit', 'code': result if result >= 0 else None,
                'signal': signal.Signals(-result).name if result < 0 else None})
    if bridge is not None and bridge.poll() is not None and not sealed:
        terminate()
        report_bridge_failure()
    # Keep the original group and private channel alive until retained cgroup.kill.
    # Controller disconnect cannot create a start permission or forget descendants.
`;
