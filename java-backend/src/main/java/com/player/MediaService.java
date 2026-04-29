package com.player;

import org.springframework.stereotype.Service;
import java.io.File;
import java.io.IOException;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

import ws.schild.jave.info.MultimediaInfo;
import ws.schild.jave.MultimediaObject;
import ws.schild.jave.ScreenExtractor;

@Service
public class MediaService {

    private final List<String> videoExts = Arrays.asList(".mp4", ".mkv", ".avi", ".mov", ".webm");
    private final List<String> audioExts = Arrays.asList(".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg");
    private final String userHome = System.getProperty("user.home");
    private final String projectRoot = new File("").getAbsolutePath();
    private final String thumbDir = Paths.get(projectRoot, "thumbnails-java").toString();

    public MediaService() {
        new File(thumbDir).mkdirs();
    }

    public List<MediaMetadata> getMediaList() throws IOException {
        List<String> baseDirs = new ArrayList<>(Arrays.asList(
                Paths.get(userHome, "Videos").toString(),
                Paths.get(userHome, "Music").toString(),
                Paths.get(userHome, "Downloads").toString()
        ));

        String fallbackMedia = Paths.get(projectRoot, "local_media").toString();
        if (new File(fallbackMedia).exists()) {
            baseDirs.add(fallbackMedia);
        }

        List<MediaMetadata> mediaList = new ArrayList<>();

        for (String directory : baseDirs) {
            File dirFile = new File(directory);
            if (!dirFile.exists() || !dirFile.isDirectory()) continue;

            scanDirectory(dirFile.toPath(), mediaList, 2);
        }

        mediaList.sort((a, b) -> Long.compare(b.getModified(), a.getModified()));
        return mediaList;
    }

    private void scanDirectory(Path directory, List<MediaMetadata> mediaList, int depth) throws IOException {
        Files.walkFileTree(directory, EnumSet.noneOf(FileVisitOption.class), depth, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String fileName = file.getFileName().toString();
                String ext = getFileExtension(fileName).toLowerCase();

                boolean isVideo = videoExts.contains(ext);
                boolean isAudio = audioExts.contains(ext);

                if (isVideo || isAudio) {
                    try {
                        mediaList.add(getMetadata(file.toFile(), isVideo));
                    } catch (Exception e) {
                        // Log and skip if error
                    }
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private MediaMetadata getMetadata(File file, boolean isVideo) {
        long size = file.length();
        long modified = file.lastModified();
        double duration = 0;

        try {
            MultimediaObject multimediaObject = new MultimediaObject(file);
            MultimediaInfo info = multimediaObject.getInfo();
            duration = (double) info.getDuration() / 1000.0;
        } catch (Exception e) {
            // Ignore error
        }

        return new MediaMetadata(
                file.getName(),
                file.getAbsolutePath(),
                size,
                modified,
                duration,
                isVideo ? "video" : "audio",
                file.getParent()
        );
    }

    private String getFileExtension(String fileName) {
        int lastIndex = fileName.lastIndexOf(".");
        return lastIndex == -1 ? "" : fileName.substring(lastIndex);
    }

    public File getThumbnail(String videoPath) throws IOException, NoSuchAlgorithmException {
        String hashName = md5(videoPath) + ".jpg";
        File thumbFile = new File(thumbDir, hashName);

        if (!thumbFile.exists()) {
            generateThumbnail(new File(videoPath), thumbFile);
        }

        return thumbFile;
    }

    private void generateThumbnail(File videoFile, File thumbFile) {
        try {
            MultimediaObject multimediaObject = new MultimediaObject(videoFile);
            ScreenExtractor screenExtractor = new ScreenExtractor();
            // Capture frame at 1 second mark or somewhere in the middle
            // Capture frame at 1 second mark (1000ms) with quality/index 1
            screenExtractor.render(multimediaObject, 320, 180, 1000, thumbFile, 1);
        } catch (Exception e) {
            // Log error
        }
    }

    private String md5(String input) throws NoSuchAlgorithmException {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] hashInBytes = md.digest(input.getBytes());
        StringBuilder sb = new StringBuilder();
        for (byte b : hashInBytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
