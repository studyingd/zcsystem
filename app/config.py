import logging
import os
import threading

import boto3
from botocore.client import Config
from mysql.connector import Error, pooling

logger = logging.getLogger(__name__)

DB_CONFIG = {
    'host': os.environ['DB_HOST'],
    'user': os.environ['DB_USER'],
    'password': os.environ['DB_PASSWORD'],
    'database': os.environ['DB_NAME'],
    'charset': 'utf8mb4',
    'use_pure': True
}

# 连接池为每进程独立：容量需 ≥ 该进程的请求线程数（gunicorn WEB_THREADS），
# 否则高峰期 get_connection 抛 PoolError → 全部请求 500「数据库连接失败」。
# 默认 8 = WEB_THREADS(4) + 预留；可用 DB_POOL_SIZE 覆盖。
#
# 池惰性创建：mysql-connector 建池时会立即连满 pool_size 条连接，
# 若在导入期建池，DB 不在则整个应用无法 import（CI/测试/冷启动全挂）。
# 改为首次 get_db_connection() 时建池，启动不再依赖 DB 存活。
_pool_lock = threading.Lock()
_db_pool = None


def _get_pool():
    global _db_pool
    if _db_pool is None:
        with _pool_lock:
            if _db_pool is None:
                _db_pool = pooling.MySQLConnectionPool(
                    pool_name='zcsystem_pool',
                    pool_size=max(int(os.environ.get('DB_POOL_SIZE', '8')), 1),
                    **DB_CONFIG,
                )
    return _db_pool

RUSTFS_CONFIG = {
    'endpoint_url': os.environ['S3_ENDPOINT'],
    'aws_access_key_id': os.environ['S3_ACCESS_KEY'],
    'aws_secret_access_key': os.environ['S3_SECRET_KEY'],
    'config': Config(signature_version='s3v4')
}


def get_db_connection():
    try:
        return _get_pool().get_connection()
    except Error as e:
        logger.error("数据库连接错误: %s", e)
        return None


S3_EXTERNAL_URL = os.environ.get('S3_EXTERNAL_URL', os.environ['S3_ENDPOINT'])
# 附件存储桶：默认 zcsystem，可用环境变量覆盖，避免桶名硬编码在业务代码里
S3_BUCKET = os.environ.get('S3_BUCKET', 'zcsystem')


def get_s3_client():
    return boto3.client('s3', **RUSTFS_CONFIG)
