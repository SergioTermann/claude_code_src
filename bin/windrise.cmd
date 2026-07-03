@echo off
setlocal EnableExtensions

set "ROOT=%~dp0.."
set "RUNNER=%ROOT%\scripts\run-lmstudio-claude.mjs"
set "CHAT=%ROOT%\scripts\windrise-chat.mjs"

if "%ANTHROPIC_MODEL_PROVIDER%"=="" set "ANTHROPIC_MODEL_PROVIDER=siliconflow"
if "%SILICONFLOW_BASE_URL%"=="" set "SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1"
if "%SILICONFLOW_MODEL%"=="" set "SILICONFLOW_MODEL=Qwen/Qwen3.6-35B-A3B"
if "%LMSTUDIO_BASE_URL%"=="" set "LMSTUDIO_BASE_URL=%SILICONFLOW_BASE_URL%"
if "%LMSTUDIO_MODEL%"=="" set "LMSTUDIO_MODEL=%SILICONFLOW_MODEL%"
if "%LMSTUDIO_CHAT_MODEL%"=="" set "LMSTUDIO_CHAT_MODEL=%LMSTUDIO_MODEL%"
if "%LMSTUDIO_FORCE_CHAT%"=="" set "LMSTUDIO_FORCE_CHAT=1"
if "%MAX_THINKING_TOKENS%"=="" set "MAX_THINKING_TOKENS=0"
if "%WINDRISE_ENABLE_THINKING%"=="" set "WINDRISE_ENABLE_THINKING=0"
if "%DISABLE_INSTALLATION_CHECKS%"=="" set "DISABLE_INSTALLATION_CHECKS=1"
set "WINDRISE=1"

if "%~1"=="" goto chat
if /I "%~1"=="help" goto help
if /I "%~1"=="-h" goto help
if /I "%~1"=="--help" goto help
if /I "%~1"=="chat" goto chat
if /I "%~1"=="ask" goto ask
if /I "%~1"=="doctor" goto doctor
if /I "%~1"=="skills" goto skills
if /I "%~1"=="search" goto search
if /I "%~1"=="trace" goto trace
if /I "%~1"=="read" goto read
if /I "%~1"=="tree" goto tree
if /I "%~1"=="web" goto web
if /I "%~1"=="fetch" goto fetch
if /I "%~1"=="weather" goto weather
goto once

:help
echo windrise Windows 用法:
echo   windrise.cmd                         启动完整交互界面
echo   windrise.cmd ask                     启动普通回车对话
echo   windrise.cmd "303804是什么故障"       自动检索知识库并总结
echo   windrise.cmd search 偏航 电机        直接检索多个关键词
echo   windrise.cmd trace 303804            显示知识路径
echo   windrise.cmd doctor                  检查 SiliconFlow / LLMWiki 状态
exit /b 0

:chat
node "%RUNNER%" %*
exit /b %ERRORLEVEL%

:ask
node "%CHAT%"
exit /b %ERRORLEVEL%

:doctor
node "%RUNNER%" --print --bare "/lmstudio"
exit /b %ERRORLEVEL%

:skills
node "%RUNNER%" --print --bare "/lmstudio skills"
exit /b %ERRORLEVEL%

:search
shift /1
node "%RUNNER%" --print --bare "/llmwiki search %* --limit 8"
exit /b %ERRORLEVEL%

:trace
shift /1
node "%RUNNER%" --print --bare "/llmwiki trace %* --limit 6"
exit /b %ERRORLEVEL%

:read
shift /1
node "%RUNNER%" --print --bare "/llmwiki read %*"
exit /b %ERRORLEVEL%

:tree
shift /1
if "%~1"=="" (
  node "%RUNNER%" --print --bare "/llmwiki tree --depth 2 --limit 50"
) else (
  node "%RUNNER%" --print --bare "/llmwiki tree %* --depth 2 --limit 50"
)
exit /b %ERRORLEVEL%

:web
shift /1
(echo web %*& echo exit) | node "%CHAT%"
exit /b %ERRORLEVEL%

:fetch
shift /1
(echo fetch %*& echo exit) | node "%CHAT%"
exit /b %ERRORLEVEL%

:weather
shift /1
(echo weather %* 天气& echo exit) | node "%CHAT%"
exit /b %ERRORLEVEL%

:once
(echo %*& echo exit) | node "%CHAT%"
exit /b %ERRORLEVEL%
