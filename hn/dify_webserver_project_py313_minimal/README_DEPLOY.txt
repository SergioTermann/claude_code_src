华能吉林公司智能助手离线部署说明

适用环境：
Linux x86_64，Python 3.13，离线机器。

安装依赖：
cd offline_install
tar -xzf dify_webserver_linux_x86_64_py313_minimal.tar.gz
cd dify_webserver_linux_x86_64_py313_minimal
chmod +x install.sh
./install.sh

启动服务：
cd ../..
python3.13 dify_web_server_.py

访问地址：
http://服务器IP:5002

说明：
本项目不再使用本地知识检索；知识库请在 Dify 中维护。
如果没有 topic_shift_detector.py，主程序也会使用内置简化版本，不影响启动。
