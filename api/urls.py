from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/media/', views.media_list_api, name='media_list_api'),
    path('api/scan-status/', views.scan_status_api, name='scan_status_api'),
    path('scan-media', views.media_list_api, {'action': 'refresh'}, name='scan_media_redirect'),
    path('api/stream/', views.stream_media, name='stream_media'),
    path('api/thumbnail/', views.thumbnail_api, name='thumbnail_api'),
    path('api/download/', views.download_api, name='download_api'),
    path('api/download/status/', views.download_status_api, name='download_status_api'),
    path('api/download/progress-sse/', views.download_progress_sse, name='download_progress_sse'),
    path('api/download/info/', views.download_info_api, name='download_info_api'),
    path('api/favorites/', views.favorites_api, name='favorites_api'),
    path('api/delete/', views.delete_media_api, name='delete_media_api'),
    path('api/search/', views.search_api, name='search_api'),
    path('manifest.json', views.pwa_manifest, name='pwa_manifest'),
    path('sw.js', views.pwa_sw, name='pwa_sw'),
]
