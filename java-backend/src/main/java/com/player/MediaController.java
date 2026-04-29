package com.player;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.scheduling.annotation.Async;
import org.springframework.web.bind.annotation.*;

import java.io.File;
import java.io.IOException;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@CrossOrigin(origins = "*") // For local dev
public class MediaController {

    @Autowired
    private MediaService mediaService;

    @GetMapping("/api/media/")
    public ResponseEntity<Map<String, List<MediaMetadata>>> getMediaList() {
        try {
            List<MediaMetadata> mediaList = mediaService.getMediaList();
            Map<String, List<MediaMetadata>> response = new HashMap<>();
            response.put("media", mediaList);
            return ResponseEntity.ok(response);
        } catch (IOException e) {
            return ResponseEntity.status(500).build();
        }
    }

    @GetMapping("/api/thumbnail/")
    public ResponseEntity<FileSystemResource> getThumbnail(@RequestParam String path) {
        try {
            File thumbFile = mediaService.getThumbnail(path);
            if (thumbFile.exists()) {
                return ResponseEntity.ok()
                        .contentType(MediaType.IMAGE_JPEG)
                        .body(new FileSystemResource(thumbFile));
            }
        } catch (IOException | NoSuchAlgorithmException e) {
            // Log error
        }
        return ResponseEntity.notFound().build();
    }

    @GetMapping("/api/stream/")
    public ResponseEntity<FileSystemResource> streamMedia(@RequestParam String path) {
        File file = new File(path);
        if (file.exists()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(new FileSystemResource(file));
        }
        return ResponseEntity.notFound().build();
    }

    @PostMapping("/api/delete/")
    public ResponseEntity<Map<String, String>> deleteMedia(@RequestBody Map<String, List<String>> request) {
        List<String> paths = request.get("paths");
        Map<String, String> response = new HashMap<>();
        if (paths == null || paths.isEmpty()) {
            response.put("error", "No paths provided");
            return ResponseEntity.badRequest().body(response);
        }

        int deletedCount = 0;
        for (String path : paths) {
            File file = new File(path);
            if (file.exists() && file.delete()) {
                deletedCount++;
            }
        }

        response.put("message", deletedCount + " file(s) deleted successfully");
        return ResponseEntity.ok(response);
    }

    @GetMapping("/api/share/")
    public ResponseEntity<Map<String, String>> shareMedia(@RequestParam String path) {
        File file = new File(path);
        Map<String, String> response = new HashMap<>();
        if (file.exists()) {
            response.put("status", "success");
            response.put("name", file.getName());
            response.put("path", file.getAbsolutePath());
            // In a real app, you might generate a temporary token or unique link here
            return ResponseEntity.ok(response);
        }
        response.put("error", "File not found");
        return ResponseEntity.status(404).body(response);
    }

    @GetMapping("/api/media/download/")
    public ResponseEntity<FileSystemResource> downloadLocalFile(@RequestParam String path) {
        File file = new File(path);
        if (file.exists()) {
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + file.getName() + "\"")
                    .contentType(MediaType.APPLICATION_OCTET_STREAM)
                    .body(new FileSystemResource(file));
        }
        return ResponseEntity.notFound().build();
    }

    @PostMapping("/api/download/")
    public ResponseEntity<Map<String, String>> download(@RequestBody Map<String, String> request) {
        String url = request.get("url");
        String formatType = request.getOrDefault("quality", "720p");

        if (url == null || url.isEmpty()) {
            Map<String, String> response = new HashMap<>();
            response.put("error", "URL is required");
            return ResponseEntity.badRequest().body(response);
        }

        startDownload(url, formatType);

        Map<String, String> response = new HashMap<>();
        response.put("message", "Download started! The file will appear in your Library when finished.");
        return ResponseEntity.ok(response);
    }

    @Async
    public void startDownload(String url, String formatType) {
        // Find or Create Download directory in project root
        String downloadDir = new File("").getAbsolutePath() + File.separator + "local_media";
        new File(downloadDir).mkdirs();
        
        String downloadPath = downloadDir + File.separator + "%(title)s.%(ext)s";
        
        // Quality mapping
        String format = "bestvideo[height<=720]+bestaudio/best[height<=720]"; // Default 720p
        if ("480p".equals(formatType)) {
            format = "bestvideo[height<=480]+bestaudio/best[height<=480]";
        } else if ("1080p".equals(formatType)) {
            format = "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
        } else if ("audio".equals(formatType)) {
            format = "bestaudio/best";
        }

        try {
            String venvPath = new File("").getAbsolutePath() + File.separator + "venv" + File.separator + "Scripts" + File.separator + "python.exe";
            ProcessBuilder pb = new ProcessBuilder(venvPath, "-m", "yt_dlp", 
                "-o", downloadPath, 
                "--no-playlist", 
                "-f", format, 
                "--merge-output-format", "mp4",
                url);
            
            Process process = pb.start();
            process.waitFor();
            System.out.println("Download complete! Saved to local_media: " + url);
        } catch (IOException | InterruptedException e) {
            e.printStackTrace();
        }
    }

    @GetMapping("/manifest.json")
    public ResponseEntity<org.springframework.core.io.ClassPathResource> getManifest() {
        org.springframework.core.io.ClassPathResource manifest = new org.springframework.core.io.ClassPathResource("static/manifest.json");
        if (manifest.exists()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(manifest);
        }
        return ResponseEntity.notFound().build();
    }

    @GetMapping("/sw.js")
    public ResponseEntity<org.springframework.core.io.ClassPathResource> getServiceWorker() {
        org.springframework.core.io.ClassPathResource sw = new org.springframework.core.io.ClassPathResource("static/sw.js");
        if (sw.exists()) {
            return ResponseEntity.ok()
                    .contentType(MediaType.valueOf("application/javascript"))
                    .body(sw);
        }
        return ResponseEntity.notFound().build();
    }
}
