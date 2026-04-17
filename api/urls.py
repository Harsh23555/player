from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('api/media/', views.media_list_api, name='media_list_api'),
    path('api/stream/', views.stream_media, name='stream_media'),
    path('api/thumbnail/', views.thumbnail_api, name='thumbnail_api'),
    path('api/download/', views.download_api, name='download_api'),
    path('api/favorites/', views.favorites_api, name='favorites_api'),
    path('api/search/', views.search_api, name='search_api'),
    path('manifest.json', views.pwa_manifest, name='pwa_manifest'),
    path('sw.js', views.pwa_sw, name='pwa_sw'),
]
