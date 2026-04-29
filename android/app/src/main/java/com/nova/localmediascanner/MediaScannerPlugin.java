package com.nova.localmediascanner;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MediaScanner")
public class MediaScannerPlugin extends Plugin {

    @PluginMethod
    public void getMediaFiles(PluginCall call) {
        JSArray medias = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();

        // 1. Audio Files
        Uri audioUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] audioProjection = {
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.DATE_MODIFIED,
                MediaStore.Audio.Media.ALBUM
        };

        try (Cursor cursor = resolver.query(audioUri, audioProjection, null, null, MediaStore.Audio.Media.DATE_MODIFIED + " DESC")) {
            if (cursor != null) {
                int dataCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATA);
                int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                int durCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int modCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED);
                int albumCol = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);

                while (cursor.moveToNext()) {
                    JSObject media = new JSObject();
                    media.put("identifier", cursor.getString(dataCol));
                    media.put("name", cursor.getString(nameCol));
                    media.put("type", "audio");
                    media.put("size", cursor.getLong(sizeCol));
                    media.put("duration", cursor.getLong(durCol) / 1000.0);
                    media.put("creationDate", cursor.getLong(modCol) * 1000); 
                    media.put("albumIdentifier", cursor.getString(albumCol));
                    medias.put(media);
                }
            }
        } catch (Exception e) {
            Log.e("MediaScanner", "Error querying audio", e);
        }

        // 2. Video Files
        Uri videoUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        String[] videoProjection = {
                MediaStore.Video.Media._ID,
                MediaStore.Video.Media.DATA,
                MediaStore.Video.Media.DISPLAY_NAME,
                MediaStore.Video.Media.SIZE,
                MediaStore.Video.Media.DURATION,
                MediaStore.Video.Media.DATE_MODIFIED,
                MediaStore.Video.Media.BUCKET_DISPLAY_NAME
        };

        try (Cursor cursor = resolver.query(videoUri, videoProjection, null, null, MediaStore.Video.Media.DATE_MODIFIED + " DESC")) {
            if (cursor != null) {
                int dataCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DATA);
                int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME);
                int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE);
                int durCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION);
                int modCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DATE_MODIFIED);
                int bucketCol = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.BUCKET_DISPLAY_NAME);

                while (cursor.moveToNext()) {
                    JSObject media = new JSObject();
                    media.put("identifier", cursor.getString(dataCol));
                    media.put("name", cursor.getString(nameCol));
                    media.put("type", "video");
                    media.put("size", cursor.getLong(sizeCol));
                    media.put("duration", cursor.getLong(durCol) / 1000.0);
                    media.put("creationDate", cursor.getLong(modCol) * 1000);
                    media.put("albumIdentifier", cursor.getString(bucketCol));
                    medias.put(media);
                }
            }
        } catch (Exception e) {
            Log.e("MediaScanner", "Error querying video", e);
        }

        JSObject result = new JSObject();
        result.put("medias", medias);
        call.resolve(result);
    }
}
