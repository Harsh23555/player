import os
import cv2
import json
import time
import hashlib
import threading
import yt_dlp
from tinytag import TinyTag
from django.shortcuts import render
from django.http import JsonResponse, FileResponse, HttpResponseNotFound, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt

# ── Supported formats ──────────────────────────────────────────────────────
VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ts', '.mpg', '.mpeg'}
AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma', '.opus', '.mid', '.midi', '.amr', '.ape'}

# Folders to skip during scanning (system/junk)
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
    """Extract duration in seconds; tries TinyTag first, then OpenCV for video."""
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
    """Convert MediaFile model instance to a dict for the JSON response."""
    return {
        'name': mf.name,
        'path': mf.path,
        'type': mf.media_type,
        'size': mf.size,
        'duration': mf.duration,
        'folder': mf.folder,
        'modified': mf.modified * 1000,  # ms for JS Date
    }

# ── Background Drive Scanner ────────────────────────────────────────────────
def get_all_drives():
    """Return all local drive letters on Windows using built-in ctypes."""
    if os.name != 'nt':
        return ['/']
    import ctypes
    bitmask = ctypes.windll.kernel32.GetLogicalDrives()
    result = []
    for i in range(26):
        if bitmask & (1 << i):
            drive = f"{chr(65 + i)}:\\"
            # 3 = DRIVE_FIXED, 2 = DRIVE_REMOVABLE
            dtype = ctypes.windll.kernel32.GetDriveTypeW(drive)
            if dtype in (2, 3):
                result.append(drive)
    return result


def scan_drives_background(force=False):
    """Recursively scan all drives and upsert MediaFile records."""
    global _is_scanning
    from .models import MediaFile

    with _scan_lock:
        if _is_scanning and not force:
            return
        _is_scanning = True

    try:
        now = time.time()
        drives = get_all_drives()
        print(f"[NOVA Scanner] Starting scan of drives: {drives}")

        for drive in drives:
            _scan_progress['current_drive'] = drive
            for root, dirs, files in os.walk(drive):
                # Prune system directories
                dirs[:] = [
                    d for d in dirs
                    if d.lower() not in SKIP_DIRS and not d.startswith('$')
                ]

                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    
                    # Special check for .ts: skip if it's very likely a TypeScript/Translation file
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

                        if fsize < 1024:  # skip tiny/corrupt files
                            continue

                        existing = MediaFile.objects.filter(path=fpath).first()
                        if existing:
                            # Only re-read metadata if file changed
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
                    except (PermissionError, OSError):
                        continue
                    except Exception as e:
                        print(f"[NOVA Scanner] Error indexing {fpath}: {e}")
                        continue

        # Remove stale entries (files no longer on disk)
        cutoff = now - 10  # files not seen in this scan run
        stale = MediaFile.objects.filter(last_seen__lt=cutoff)
        stale_count = stale.count()
        stale.delete()
        print(f"[NOVA Scanner] Scan complete. Removed {stale_count} stale records.")

    except Exception as e:
        print(f"[NOVA Scanner] Fatal scan error: {e}")
    finally:
        with _scan_lock:
            _is_scanning = False
            _scan_progress['current_drive'] = 'Complete'


def trigger_scan(force=False):
    """Start a background scan thread if one isn't already running."""
    global _scan_thread, _is_scanning
    if _is_scanning and not force:
        return
    _scan_progress['files_found'] = 0
    _scan_progress['start_time'] = time.time()
    _scan_thread = threading.Thread(target=scan_drives_background, args=(force,), daemon=True)
    _scan_thread.start()


# ── Auto-trigger on startup if DB is empty ─────────────────────────────────
def _startup_scan():
    import time as _time
    _time.sleep(2)  # let Django finish starting up
    try:
        from .models import MediaFile
        if MediaFile.objects.count() == 0:
            print("[NOVA Scanner] DB empty — starting initial drive scan...")
            scan_drives_background(force=True)
    except Exception as e:
        print(f"[NOVA Scanner] Startup check failed: {e}")

threading.Thread(target=_startup_scan, daemon=True).start()


# ── API Views ───────────────────────────────────────────────────────────────
def media_list_api(request):
    """Return indexed media from DB. Supports ?action=refresh to trigger a new scan."""
    from .models import MediaFile

    if request.GET.get('action') == 'refresh':
        trigger_scan(force=True)

    # If scanning, let frontend know
    scanning = _is_scanning

    qs = MediaFile.objects.all().order_by('-modified')

    type_filter = request.GET.get('type', '')
    if type_filter in ('audio', 'video'):
        qs = qs.filter(media_type=type_filter)

    media = [build_media_dict(m) for m in qs[:2000]]
    return JsonResponse({'media': media, 'scanning': scanning, 'progress': _scan_progress})


def scan_status_api(request):
    """Report current scan progress."""
    return JsonResponse({
        'scanning': _is_scanning,
        'progress': _scan_progress
    })


def search_api(request):
    from .models import MediaFile
    query = request.GET.get('q', '').strip()
    type_filter = request.GET.get('type', '')

    qs = MediaFile.objects.all()
    if query:
        qs = qs.filter(name__icontains=query)
    if type_filter in ('audio', 'video'):
        qs = qs.filter(media_type=type_filter)

    qs = qs.order_by('-modified')[:200]
    return JsonResponse({'media': [build_media_dict(m) for m in qs]})


def stream_media(request):
    """Stream a local file with support for Range requests (seek support)."""
    path = request.GET.get('path', '')
    print(f"[NOVA Player] Stream request for: {path}")
    
    if not path or not os.path.exists(path):
        print(f"[NOVA Player] File not found or empty path: {path}")
        return HttpResponseNotFound('File not found')

    # Security: only allow files that are indexed in our DB
    from .models import MediaFile
    # On Windows, try both forward and backslashes for the DB check
    if not MediaFile.objects.filter(path=path).exists():
        normalized_path = path.replace('/', '\\')
        if not MediaFile.objects.filter(path=normalized_path).exists():
            print(f"[NOVA Player] Security check failed: Path not indexed in DB: {path}")
            return HttpResponseNotFound('Not indexed')
        path = normalized_path

    file_size = os.path.getsize(path)
    ext = os.path.splitext(path)[1].lower()
    content_type_map = {
        '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
        '.aac': 'audio/aac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
        '.wma': 'audio/x-ms-wma', '.opus': 'audio/opus',
    }
    content_type = content_type_map.get(ext, 'application/octet-stream')

    range_header = request.META.get('HTTP_RANGE', '').strip()
    if range_header:
        # Parse Range: bytes=start-end
        try:
            unit, ranges = range_header.split('=')
            start_str, end_str = ranges.split('-')
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
        except Exception:
            start, end = 0, file_size - 1

        end = min(end, file_size - 1)
        length = end - start + 1

        def file_iterator(fpath, s, l, chunk=65536):
            with open(fpath, 'rb') as f:
                f.seek(s)
                remaining = l
                while remaining > 0:
                    data = f.read(min(chunk, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        response = StreamingHttpResponse(
            file_iterator(path, start, length),
            status=206,
            content_type=content_type,
        )
        response['Content-Range'] = f'bytes {start}-{end}/{file_size}'
        response['Content-Length'] = str(length)
        response['Accept-Ranges'] = 'bytes'
        return response

    return FileResponse(open(path, 'rb'), content_type=content_type)


def thumbnail_api(request):
    path = request.GET.get('path', '')
    if not path or not os.path.exists(path):
        return HttpResponseNotFound()

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
        except Exception:
            pass

    if os.path.exists(thumb_path):
        return FileResponse(open(thumb_path, 'rb'), content_type='image/jpeg')
    
    # Return a 1x1 transparent pixel instead of 404 to avoid console spam
    import base64
    pixel = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
    from django.http import HttpResponse
    return HttpResponse(pixel, content_type='image/gif')


def pwa_manifest(request):
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'static', 'manifest.json')
    if os.path.exists(path):
        return FileResponse(open(path, 'rb'), content_type='application/json')
    return HttpResponseNotFound()


def pwa_sw(request):
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'static', 'sw.js')
    if os.path.exists(path):
        return FileResponse(open(path, 'rb'), content_type='application/javascript')
    return HttpResponseNotFound()


@csrf_exempt
def favorites_api(request):
    from .models import MediaFavorite
    if request.method == 'GET':
        favs = MediaFavorite.objects.all().order_by('-added_at')
        data = [{'name': f.name, 'path': f.path, 'type': f.media_type} for f in favs]
        return JsonResponse({'favorites': data})

    elif request.method == 'POST':
        try:
            data = json.loads(request.body)
            f, created = MediaFavorite.objects.get_or_create(
                path=data.get('path'),
                defaults={'name': data.get('name'), 'media_type': data.get('type', 'video')}
            )
            return JsonResponse({'message': 'Added', 'created': created})
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)

    elif request.method == 'DELETE':
        path = request.GET.get('path')
        MediaFavorite.objects.filter(path=path).delete()
        return JsonResponse({'message': 'Removed'})

    return JsonResponse({'error': 'Method not allowed'}, status=405)


def download_background(url, format_type):
    ydl_opts = {
        'outtmpl': os.path.join(os.path.expanduser('~'), 'Downloads', '%(title)s.%(ext)s'),
        'quiet': True,
        'noplaylist': True,
    }
    if format_type == 'audio':
        ydl_opts['format'] = 'ba/bestaudio'
    elif format_type == '1080p':
        ydl_opts['format'] = 'b[height<=1080]/b'
    else:
        ydl_opts['format'] = 'b[height<=720]/b'

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        # Trigger re-scan after download completes
        trigger_scan(force=False)
    except Exception as e:
        print(f"[NOVA Download] Failed: {e}")


@csrf_exempt
def download_api(request):
    if request.method == 'POST':
        try:
            data = json.loads(request.body)
            url = data.get('url')
            format_type = data.get('format', '720p')
            if not url:
                return JsonResponse({"error": "URL is required"}, status=400)
            thread = threading.Thread(target=download_background, args=(url, format_type))
            thread.start()
            return JsonResponse({"message": "Download started!"})
        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)
    return JsonResponse({"error": "Method not allowed"}, status=405)
@csrf_exempt
def delete_media_api(request):
    """Permanently delete one or more media files from disk and DB."""
    if request.method != 'POST':
        return JsonResponse({'error': 'Method not allowed'}, status=405)
    
    try:
        data = json.loads(request.body)
        paths = data.get('paths', [])
        if not paths:
            return JsonResponse({'error': 'No paths provided'}, status=400)
        
        from .models import MediaFile
        deleted_count = 0
        errors = []

        for path in paths:
            mf = MediaFile.objects.filter(path=path).first()
            if not mf:
                errors.append(f"Not indexed: {path}")
                continue
            
            try:
                if os.path.exists(path):
                    os.remove(path)
                    deleted_count += 1
                else:
                    errors.append(f"File not found on disk: {path}")
            except Exception as e:
                errors.append(f"Failed to delete {path}: {str(e)}")
                continue
            
            mf.delete()
            
            # Cleanup thumbnail
            hash_name = hashlib.md5(path.encode('utf-8')).hexdigest() + '.jpg'
            thumb_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'thumbnails')
            thumb_path = os.path.join(thumb_dir, hash_name)
            if os.path.exists(thumb_path):
                try: os.remove(thumb_path)
                except: pass

        return JsonResponse({
            'message': f'Successfully deleted {deleted_count} files',
            'deleted_count': deleted_count,
            'errors': errors
        })
    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)
