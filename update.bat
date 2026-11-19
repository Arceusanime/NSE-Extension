@echo off
setlocal enabledelayedexpansion
title NSE Scanner - Auto Update Utility

echo ========================================================
echo       NSE Option Chain Scanner - Auto Updater
echo ========================================================
echo.

:: 1. Verify Git Installation
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git is not installed on this system or not in PATH!
    echo.
    echo Please install Git for Windows from:
    echo https://git-scm.com/download/win
    echo (Make sure to check "Add to PATH" during installation)
    echo.
    echo Press any key to exit...
    pause >nul
    exit /b 1
)

:: 2. Navigate to this script's directory
cd /d "%~dp0"

:: 3. Verify it is a valid Git repository
if not exist ".git" (
    echo [ERROR] No .git directory found in: %cd%
    echo Make sure update.bat is placed in the extension root folder.
    echo.
    pause
    exit /b 1
)

echo [*] Checking connection and fetching updates from GitHub...
git fetch origin
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Failed to connect to GitHub repository.
    echo Please check your internet connection or repository access.
    echo.
    pause
    exit /b 1
)

:: 4. Detect branch (master or main)
set BRANCH=master
git rev-parse --verify origin/master >nul 2>nul
if %ERRORLEVEL% neq 0 (
    git rev-parse --verify origin/main >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        set BRANCH=main
    )
)

:: 5. Compare local commit with remote commit
for /f %%i in ('git rev-parse HEAD 2^>nul') do set LOCAL_HASH=%%i
for /f %%i in ('git rev-parse origin/%BRANCH% 2^>nul') do set REMOTE_HASH=%%i

if "%LOCAL_HASH%"=="" (
    echo [ERROR] Could not determine local Git commit.
    pause
    exit /b 1
)

if "%LOCAL_HASH%"=="%REMOTE_HASH%" (
    echo.
    echo [OK] Everything is up to date!
    echo Current Branch: %BRANCH%
    echo Commit: %LOCAL_HASH:~0,7%
    echo.
    echo No new updates on GitHub.
) else (
    echo.
    echo [+] New update found on GitHub (%BRANCH%)!
    echo Local:  %LOCAL_HASH:~0,7%
    echo Remote: %REMOTE_HASH:~0,7%
    echo.
    echo [*] Pulling latest updates...
    
    :: Stash any accidental local edits so pull never conflicts
    git stash >nul 2>nul
    git pull origin %BRANCH%
    
    if %ERRORLEVEL% equ 0 (
        echo.
        echo ========================================================
        echo [SUCCESS] Extension updated successfully!
        echo.
        echo What to do next:
        echo 1. Open the extension popup or dashboard in Chrome.
        echo 2. Click "Reload" (or refresh chrome://extensions).
        echo ========================================================
    ) else (
        echo.
        echo [WARNING] Git pull encountered an issue.
        echo Please try: git reset --hard origin/%BRANCH%
    )
)

echo.
echo Press any key to close this window...
pause >nul
