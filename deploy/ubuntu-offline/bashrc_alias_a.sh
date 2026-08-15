# CentOS 宿主机 ~/.bashrc 片段
# 作用：把 /0615 里唯一的 tar.gz 拷到 Ubuntu 容器 /workspace

alias a='f=/0615/*.tar.gz; if [ ! -e "$f" ]; then echo "ERROR: /0615 下没有 tar.gz 包"; else sudo docker cp "$f" 2797b7ba66be:/workspace/; fi'
