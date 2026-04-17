# Run script for Java Backend

# Check if Maven is available
if (!(Get-Command mvn -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Maven is not installed. Please install Maven first." -ForegroundColor Red
    exit
}

# Go to java-backend directory
cd java-backend

# Compile and Run
Write-Host "Starting Java Backend on http://localhost:8080..." -ForegroundColor Green
mvn spring-boot:run
