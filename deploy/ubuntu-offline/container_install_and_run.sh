# Ubuntu 容器内执行片段
# 作用：在 /workspace 下找到最新 tar.gz，解压，删包，执行安装并启动

cd /workspace
set -- ./*.tar.gz
if [ ! -e "$1" ]; then
  echo "ERROR: /workspace 下没有 tar.gz 包"
  exit 1
fi
f="$1"
workdir="$(basename "$f" .tar.gz)"
mkdir -p "$workdir"
tar -xzf "$f" -C "$workdir"
rm -f "$f"
cd "$workdir"
bash install_offline.sh
./run-web.sh
