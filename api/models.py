from django.db import models

class MediaFavorite(models.Model):
    name = models.CharField(max_length=500)
    path = models.CharField(max_length=1000, unique=True)
    media_type = models.CharField(max_length=10) # 'video' or 'audio'
    added_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

class MediaPlaylist(models.Model):
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    
    def __str__(self):
        return self.name

class PlaylistItem(models.Model):
    playlist = models.ForeignKey(MediaPlaylist, related_name='items', on_delete=models.CASCADE)
    media_name = models.CharField(max_length=500)
    media_path = models.CharField(max_length=1000)
    media_type = models.CharField(max_length=10)
    order = models.IntegerField(default=0)

class MediaFile(models.Model):
    """Persistent index of all discovered local media files."""
    name = models.CharField(max_length=500)
    path = models.CharField(max_length=2000, unique=True, db_index=True)
    media_type = models.CharField(max_length=10, db_index=True)  # 'audio' or 'video'
    size = models.BigIntegerField(default=0)
    duration = models.FloatField(default=0)
    folder = models.CharField(max_length=1000, default='')
    modified = models.FloatField(default=0)  # unix timestamp
    last_seen = models.FloatField(default=0)  # unix timestamp of last scan

    def __str__(self):
        return self.name
