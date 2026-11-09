@echo off
title SLR Writing Platform - Stop All Services
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1"
pause
