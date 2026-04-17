import os
import cv2
import json
import hashlib
import threading
import yt_dlp
from tinytag import TinyTag
from django.shortcuts import render
from django.http import JsonResponse, FileResponse, HttpResponseNotFound
from django.views.decorators.csrf import csrf_exempt

def index(request):
    return render(request, 'mediaapp.html')

def get_media_metadata(file_path, is_video):
    size = os.path.getsize(file_path)
    modified = os.path.getmtime(file_path)
    duration = 0
    try:
        tag = TinyTag.get(file_path)
        duration = tag.duration or 0
    except Exception:
        pass
    
    if is_video and (not duration or duration <= 0):
        try:
            vid = cv2.VideoCapture(file_path)
            if vid.isOpened():
                fps = vid.get(cv2.CAP_PROP_FPS)
                frame_count = vid.get(cv2.CAP_PROP_FRAME_COUNT)
                if fps > 0: duration = frame_count / fps
                vid.release()
        except Exception:
            pass
    
    return {
        'name': os.path.basename(file_path),
        'path': file_path,
        'size': size,
        'modified': modified,
        'duration': duration,
        'type': 'video' if is_video else 'audio',
        'folder': os.path.dirname(file_path)
    }

def media_list_api(request):
    base_dirs = [
        os.path.join(os.path.expanduser('~'), 'Videos'),
        os.path.join(os.path.expanduser('~'), 'Music'),
        os.path.join(os.path.expanduser('~'), 'Downloads'),
    ]
    fallback_media = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'local_media')
    if os.path.exists(fallback_media): base_dirs.append(fallback_media)
    
    video_exts = {'.mp4', '.mkv', '.avi', '.mov', '.webm'}
    audio_exts = {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'}
    
    media_list = []
    
    for directory in base_dirs:
        if not os.path.exists(directory):
            continue
        try:
            for root, dirs, files in os.walk(directory):
                # Only scan top 2 levels down from the base dir to keep it extremely fast
                if root[len(directory):].count(os.sep) > 2:
                    dirs[:] = []
                for f in files:
                    ext = os.path.splitext(f)[1].lower()
                    if ext in video_exts or ext in audio_exts:
                        fpath = os.path.join(root, f)
                        try:
                            meta = get_media_metadata(fpath, ext in video_exts)
                            media_list.append(meta)
                        except Exception:
                            pass
        except Exception:
            pass
            
    # Sort by recent by default
    media_list.sort(key=lambda x: x['modified'], reverse=True)
    return JsonResponse({'media': media_list})

def get_thumbnail_path(video_path):
    hash_name = hashlib.md5(video_path.encode('utf-8')).hexdigest() + '.jpg'
    thumb_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'thumbnails')
    os.makedirs(thumb_dir, exist_ok=True)
    return os.path.join(thumb_dir, hash_name)

def generate_thumbnail(video_path, thumb_path):
    if not os.path.exists(thumb_path):
        vidcap = cv2.VideoCapture(video_path)
        success, image = vidcap.read()
        if success:
            image = cv2.resize(image, (320, 180))
            cv2.imwrite(thumb_path, image)
        vidcap.release()

def thumbnail_api(request):
    path = request.GET.get('path')
    if not path or not os.path.exists(path):
        return HttpResponseNotFound()
        
    thumb_path = get_thumbnail_path(path)
    if not os.path.exists(thumb_path):
        try:
            generate_thumbnail(path, thumb_path)
        except Exception:
            pass
            
    if os.path.exists(thumb_path):
        return FileResponse(open(thumb_path, 'rb'), content_type='image/jpeg')
    return HttpResponseNotFound()

def stream_media(request):
    path = request.GET.get('path')
    if not path or not os.path.exists(path):
        return HttpResponseNotFound()
    return FileResponse(open(path, 'rb'))

def download_background(url, format_type):
    # Note: Downloading copyrighted material without permission may violate TOS or local laws.
    ydl_opts = {
        'outtmpl': os.path.join(os.path.expanduser('~'), 'Downloads', '%(title)s.%(ext)s'),
        'quiet': True,
        'noplaylist': True,
    }
    
    if format_type == 'audio':
        ydl_opts['format'] = 'ba/bestaudio'  # Safe audio download without FFmpeg conversion
    elif format_type == '1080p':
        ydl_opts['format'] = 'b[height<=1080]/b'  # Best pre-merged format up to 1080p
    else: # 720p / default
        ydl_opts['format'] = 'b[height<=720]/b'  # Best pre-merged format up to 720p
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        print(f"Download failed: {e}")

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
            
            return JsonResponse({"message": "Download started! The file will appear in your Downloads folder when finished."})
        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)
    return JsonResponse({"error": "Method not allowed"}, status=405)

def pwa_manifest(request):
    """Serve the manifest.json at the root."""
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'static', 'manifest.json')
    if os.path.exists(path):
        return FileResponse(open(path, 'rb'), content_type='application/json')
    return HttpResponseNotFound()

def pwa_sw(request):
    """Serve the sw.js at the root to allow full scope registration."""
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'static', 'sw.js')
    if os.path.exists(path):
        return FileResponse(open(path, 'rb'), content_type='application/javascript')
    return HttpResponseNotFound()

@csrf_exempt
def favorites_api(request):
    from .models import MediaFavorite
    if request.method == 'GET':
        favs = MediaFavorite.objects.all().order_by('-added_at')
        data = [{'name': f.name, 'path': f.path, 'type': f.media_type, 'source': 'remote'} for f in favs]
        return JsonResponse({'favorites': data})
    
    elif request.method == 'POST':
        try:
            data = json.loads(request.body)
            f, created = MediaFavorite.objects.get_or_create(
                path=data.get('path'),
                defaults={'name': data.get('name'), 'media_type': data.get('type', 'video')}
            )
            return JsonResponse({'message': 'Added to cloud favorites', 'created': created})
        except Exception as e:
            return JsonResponse({'error': str(e)}, status=500)
    
    elif request.method == 'DELETE':
        path = request.GET.get('path')
        MediaFavorite.objects.filter(path=path).delete()
        return JsonResponse({'message': 'Removed from favorites'})
        
    return JsonResponse({'error': 'Method not allowed'}, status=405)

def search_api(request):
    query = request.GET.get('q', '').lower()
    type_filter = request.GET.get('type', '')
    
    # Simple search on current collection
    # Reuse media_list_api logic but filter by name
    base_dirs = [
        os.path.join(os.path.expanduser('~'), 'Videos'),
        os.path.join(os.path.expanduser('~'), 'Music'),
        os.path.join(os.path.expanduser('~'), 'Downloads'),
    ]
    media_list = []
    
    for directory in base_dirs:
        if not os.path.exists(directory): continue
        for root, dirs, files in os.walk(directory):
            # Only top 2 levels
            if root[len(directory):].count(os.sep) > 2:
                dirs[:] = []
            for f in files:
                if query in f.lower():
                    ext = os.path.splitext(f)[1].lower()
                    isVideo = ext in {'.mp4', '.mkv', '.avi', '.mov', '.webm'}
                    isAudio = ext in {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg'}
                    
                    if (isVideo and type_filter != 'audio') or (isAudio and type_filter != 'video'):
                        fpath = os.path.join(root, f)
                        media_list.append(get_media_metadata(fpath, isVideo))
                        
    return JsonResponse({'media': media_list[:100]}) # Limit result
