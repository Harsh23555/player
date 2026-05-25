import os
import cv2
import json
import time
import hashlib
import threading
import uuid
import yt_dlp
import traceback
import subprocess
import sys
import base64
from tinytag import TinyTag
from django.shortcuts import render
from django.http import JsonResponse, FileResponse, HttpResponseNotFound, StreamingHttpResponse, HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

# ── Global security & rate limiting ─────────────────────────────────────────
_rate_limits = {}

def api_security(func):
    """Decorator to enforce rate limiting and basic security."""
    def wrapper(request, *args, **kwargs):
        ip = request.META.get('REMOTE_ADDR', '127.0.0.1')
        now = time.time()
        with _scan_lock:
            reqs = _rate_limits.get(ip, [])
            # Keep requests from last 60 seconds
            reqs = [t for t in reqs if now - t < 60]
            if len(reqs) > 120:  # 120 requests per minute max
                return JsonResponse({'error': 'Rate limit exceeded.'}, status=429)
            reqs.append(now)
            _rate_limits[ip] = reqs
        return func(request, *args, **kwargs)
    return wrapper

# ── Supported formats ──────────────────────────────────────────────────────
VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ts', '.mpg', '.mpeg'}
AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma', '.opus', '.mid', '.midi', '.amr', '.ape'}

SKIP_DIRS = {
    'windows', 'system32', 'syswow64', 'program files', 'program files (x86)',
    'programdata', 'appdata', '$recycle.bin', 'system volume information',
    'recovery', 'boot', 'perflogs', '$windows.~bt', 'msocache',
    'intel', 'amd', 'nvidia', 'node_modules', '.git', '__pycache__',
    'site-packages', 'winsxs', '.vscode', '.idea', '.antigravity',
    'extensions', 'typings', 'dist', 'build', '.gradle', 'venv',
}

# ── Global scanner state ────────────────────────────────────────────────────
_scan_lock = threading.Lock()
_is_scanning = False
_scan_thread = None
_scan_progress = {
    'current_drive': '',
    'files_found': 0,
    'start_time': 0,
}

def index(request):
    return render(request, 'mediaapp.html')

# ── Metadata helpers ────────────────────────────────────────────────────────
def get_duration(file_path, is_video):
    duration = 0
    try:
        tag = TinyTag.get(file_path)
        if tag.duration and tag.duration > 0:
            return tag.duration
    except Exception:
        pass
    if is_video:
        try:
            vid = cv2.VideoCapture(file_path)
            if vid.isOpened():
                fps = vid.get(cv2.CAP_PROP_FPS)
                frame_count = vid.get(cv2.CAP_PROP_FRAME_COUNT)
                if fps > 0:
                    duration = frame_count / fps
            vid.release()
        except Exception:
            pass
    return duration

def build_media_dict(mf):
    return {
        'name': mf.name,
        'path': mf.path,
        'type': mf.media_type,
        'size': mf.size,
        'duration': mf.duration,
        'folder': mf.folder,
        'modified': mf.modified * 1000,
    }

# ── Background Drive Scanner ────────────────────────────────────────────────
def get_all_drives():
    if os.name != 'nt':
        return ['/']
    import ctypes
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    result = []
    for i in range(26):
        if bitmask & (1 << i):
            drive = f"{chr(65 + i)}:\\"
            dtype = ctypes.windll.kernel32.GetDriveTypeW(drive)
            if dtype in (2, 3):
                result.append(drive)
    return result

def scan_drives_background(force=False):
    global _is_scanning
    from .models import MediaFile
    with _scan_lock:
        if _is_scanning and not force:
            return
        _is_scanning = True
    try:
        now = time.time()
        drives = get_all_drives()
        for drive in drives:
            _scan_progress['current_drive'] = drive
            for root, dirs, files in os.walk(drive):
                dirs[:] = [d for d in dirs if d.lower() not in SKIP_DIRS and not d.startswith('$')]
                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext == '.ts' and fname.endswith(('.d.ts', '.spec.ts', '.test.ts')):
                        continue
                    is_video = ext in VIDEO_EXTS
                    is_audio = ext in AUDIO_EXTS
                    if not is_video and not is_audio:
                        continue
                    fpath = os.path.join(root, fname)
                    try:
                        stat = os.stat(fpath)
                        fsize = stat.st_size
                        fmod = stat.st_mtime
                        if fsize < 1024: continue
                        existing = MediaFile.objects.filter(path=fpath).first()
                        if existing:
                            if existing.modified == fmod and existing.size == fsize:
                                existing.last_seen = now
                                existing.save(update_fields=['last_seen'])
                                continue
                        duration = get_duration(fpath, is_video)
                        MediaFile.objects.update_or_create(
                            path=fpath,
                            defaults={
                                'name': fname,
                                'media_type': 'video' if is_video else 'audio',
                                'size': fsize,
                                'duration': duration,
                                'folder': root,
                                'modified': fmod,
                                'last_seen': now,
                            }
                        )
                        _scan_progress['files_found'] += 1
                    except Exception: continue
        cutoff = now - 10
        MediaFile.objects.filter(last_seen__lt=cutoff).delete()
    finally:
        with _scan_lock:
            _is_scanning = False
            _scan_progress['current_drive'] = 'Complete'

def trigger_scan(force=False):
    global _scan_thread, _is_scanning
    if _is_scanning and not force:
        return
    _scan_progress['files_found'] = 0
    _scan_progress['start_time'] = time.time()
    _scan_thread = threading.Thread(target=scan_drives_background, args=(force,), daemon=True)
    _scan_thread.start()

# ── API Views ───────────────────────────────────────────────────────────────
def media_list_api(request):
    from .models import MediaFile
    if request.GET.get('action') == 'refresh':
        trigger_scan(force=True)
    qs = MediaFile.objects.all().order_by('-modified')
    type_filter = request.GET.get('type', '')
    if type_filter in ('audio', 'video'):
        qs = qs.filter(media_type=type_filter)
    media = [build_media_dict(m) for m in qs[:5000]]
    return JsonResponse({'media': media, 'scanning': _is_scanning, 'progress': _scan_progress})

def scan_status_api(request):
    return JsonResponse({'scanning': _is_scanning, 'progress': _scan_progress})

def search_api(request):
    from .models import MediaFile
    query = request.GET.get('q', '').strip()
    type_filter = request.GET.get('type', '')
    qs = MediaFile.objects.all()
    if query:
        qs = qs.filter(name__icontains=query)
    if type_filter in ('audio', 'video'):
        qs = qs.filter(media_type=type_filter)
    return JsonResponse({'media': [build_media_dict(m) for m in qs[:200]]})

@api_security
def stream_media(request):
    path = request.GET.get('path', '')
    if not path or not os.path.exists(path):
        return HttpResponseNotFound('File not found')
    from .models import MediaFile
    if not MediaFile.objects.filter(path=path).exists():
        path = path.replace('/', '\\')
        if not MediaFile.objects.filter(path=path).exists():
            return HttpResponseNotFound('Not indexed')
    file_size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    content_type_map = {
        '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
    }
    content_type = content_type_map.get(ext, 'application/octet-stream')
    range_header = request.META.get('HTTP_RANGE', '').strip()
    if range_header:
        try:
            unit, ranges = range_header.split('=')
            start_str, end_str = ranges.split('-')
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
        except Exception:
            start, end = 0, file_size - 1
        end = min(end, file_size - 1)
        length = end - start + 1
        def file_iterator(fpath, s, l):
            with open(fpath, 'rb') as f:
                f.seek(s)
                remaining = l
                while remaining > 0:
                    data = f.read(min(524288, remaining))
                    if not data: break
                    remaining -= len(data)
                    yield data
        response = StreamingHttpResponse(file_iterator(path, start, length), status=206, content_type=content_type)
        response['Content-Range'] = f'bytes {start}-{end}/{file_size}'
        response['Content-Length'] = str(length)
        response['Accept-Ranges'] = 'bytes'
        return response
    return FileResponse(open(path, 'rb'), content_type=content_type)

def thumbnail_api(request):
    path = request.GET.get('path', '')
    if not path or not os.path.exists(path): return HttpResponseNotFound()
    hash_name = hashlib.md5(path.encode('utf-8')).hexdigest() + '.jpg'
    thumb_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'thumbnails')
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_path = os.path.join(thumb_dir, hash_name)
    if not os.path.exists(thumb_path):
        try:
            vidcap = cv2.VideoCapture(path)
            success, image = vidcap.read()
            if success:
                image = cv2.resize(image, (320, 180))
                cv2.imwrite(thumb_path, image)
            vidcap.release()
        except Exception: pass
    if os.path.exists(thumb_path):
        return FileResponse(open(thumb_path, 'rb'), content_type='image/jpeg')
    return HttpResponse(base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), content_type='image/gif')

@csrf_exempt
def favorites_api(request):
    from .models import MediaFavorite
    if request.method == 'GET':
        favs = MediaFavorite.objects.all().order_by('-added_at')
        return JsonResponse({'favorites': [{'name': f.name, 'path': f.path, 'type': f.media_type} for f in favs]})
    elif request.method == 'POST':
        data = json.loads(request.body)
        f, created = MediaFavorite.objects.get_or_create(path=data.get('path'), defaults={'name': data.get('name'), 'media_type': data.get('type', 'video')})
        return JsonResponse({'message': 'Added', 'created': created})
    elif request.method == 'DELETE':
        MediaFavorite.objects.filter(path=request.GET.get('path')).delete()
        return JsonResponse({'message': 'Removed'})
    return JsonResponse({'error': 'Method not allowed'}, status=405)

@csrf_exempt
def delete_media_api(request):
    if request.method != 'POST': return JsonResponse({'error': 'Method not allowed'}, status=405)
    data = json.loads(request.body)
    paths = data.get('paths', [])
    from .models import MediaFile
    for path in paths:
        try:
            if os.path.exists(path): os.remove(path)
            MediaFile.objects.filter(path=path).delete()
        except: continue
    return JsonResponse({'message': 'Deleted'})

# ── Downloader Logic ───────────────────────────────────────────────────────
DOWNLOAD_BASE = os.path.join(os.path.expanduser('~'), 'NOVA_Downloads')
_tasks = {}

def _ensure_ytdlp():
    try:
        import yt_dlp
        return yt_dlp
    except ImportError:
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'yt-dlp'])
        import yt_dlp
        return yt_dlp

@csrf_exempt
def download_info_api(request):
    try:
        data = json.loads(request.body)
        url = data.get('url', '').strip()
        if not url: return JsonResponse({'error': 'No URL'}, status=400)
        yt_dlp = _ensure_ytdlp()
        with yt_dlp.YoutubeDL({'quiet': True, 'skip_download': True}) as ydl:
            info = ydl.extract_info(url, download=False)
        formats = []
        seen = set()
        for f in reversed(info.get('formats', [])):
            h = f.get('height')
            if h and f.get('vcodec') != 'none' and f.get('acodec') != 'none' and h not in seen:
                formats.append({'quality': f'{h}p', 'format_id': f.get('format_id'), 'type': 'video'})
                seen.add(h)
        formats.append({'quality': 'Audio', 'format_id': 'bestaudio', 'type': 'audio'})
        return JsonResponse({'title': info.get('title'), 'thumbnail': info.get('thumbnail'), 'available_qualities': [f['quality'] for f in formats], 'formats': formats})
    except Exception as e: return JsonResponse({'error': str(e)}, status=500)

@csrf_exempt
def download_api(request):
    data = json.loads(request.body)
    url = data.get('url')
    format_id = data.get('format_id', 'best')
    task_id = str(uuid.uuid4())
    _tasks[task_id] = {'status': 'starting', 'progress': 0}
    threading.Thread(target=_run_download, args=(task_id, url, format_id), daemon=True).start()
    return JsonResponse({'task_id': task_id})

def _run_download(task_id, url, format_id):
    try:
        yt_dlp = _ensure_ytdlp()
        task = _tasks[task_id]
        os.makedirs(DOWNLOAD_BASE, exist_ok=True)
        def hook(d):
            if d['status'] == 'downloading':
                task['status'] = 'downloading'
                task['progress'] = (d.get('downloaded_bytes', 0) / (d.get('total_bytes') or 1)) * 100
        with yt_dlp.YoutubeDL({'format': format_id, 'outtmpl': os.path.join(DOWNLOAD_BASE, '%(title)s.%(ext)s'), 'progress_hooks': [hook]}) as ydl:
            info = ydl.extract_info(url, download=True)
            task['final_path'] = ydl.prepare_filename(info)
        task['status'] = 'completed'
        task['progress'] = 100
    except Exception as e:
        _tasks[task_id]['status'] = 'error'
        _tasks[task_id]['error'] = str(e)

def download_status_api(request):
    tid = request.GET.get('task_id')
    return JsonResponse(_tasks.get(tid, {'error': 'Not found'}))

@csrf_exempt
def download_progress_sse(request):
    """Server-Sent Events for real-time download progress tracking."""
    task_id = request.GET.get('task_id')
    if not task_id:
        return JsonResponse({'error': 'task_id required'}, status=400)

    def event_stream():
        last_progress = -1
        while True:
            status = _tasks.get(task_id)
            if not status:
                yield f"data: {json.dumps({'error': 'task not found'})}\n\n"
                break
            
            if status.get('progress') != last_progress:
                yield f"data: {json.dumps(status)}\n\n"
                last_progress = status.get('progress')
            
            if status.get('status') in ('completed', 'error'):
                break
            time.sleep(0.5)

    response = StreamingHttpResponse(event_stream(), content_type='text/event-stream')
    response['Cache-Control'] = 'no-cache'
    return response

def pwa_manifest(request): return JsonResponse({})
def pwa_sw(request): return HttpResponse('', content_type='application/javascript')