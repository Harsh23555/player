package com.player;

public class MediaMetadata {
    private String name;
    private String path;
    private long size;
    private long modified;
    private double duration;
    private String type;
    private String folder;

    // Constructors, Getters/Setters
    public MediaMetadata() {}

    public MediaMetadata(String name, String path, long size, long modified, double duration, String type, String folder) {
        this.name = name;
        this.path = path;
        this.size = size;
        this.modified = modified;
        this.duration = duration;
        this.type = type;
        this.folder = folder;
    }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path; }

    public long getSize() { return size; }
    public void setSize(long size) { this.size = size; }

    public long getModified() { return modified; }
    public void setModified(long modified) { this.modified = modified; }

    public double getDuration() { return duration; }
    public void setDuration(double duration) { this.duration = duration; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getFolder() { return folder; }
    public void setFolder(String folder) { this.folder = folder; }
}
