import mysql.connector
from mysql.connector import Error
import boto3
from botocore.client import Config
import os

DB_CONFIG = {
    'host': os.environ['DB_HOST'],
    'user': os.environ['DB_USER'],
    'password': os.environ['DB_PASSWORD'],
    'database': os.environ['DB_NAME'],
    'charset': 'utf8mb4',
    'use_pure': True
}

RUSTFS_CONFIG = {
    'endpoint_url': os.environ['S3_ENDPOINT'],
    'aws_access_key_id': os.environ['S3_ACCESS_KEY'],
    'aws_secret_access_key': os.environ['S3_SECRET_KEY'],
    'config': Config(signature_version='s3v4')
}


def get_db_connection():
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except Error as e:
        print(f"数据库连接错误: {e}")
        return None


S3_EXTERNAL_URL = os.environ.get('S3_EXTERNAL_URL', os.environ['S3_ENDPOINT'])


def get_s3_client():
    return boto3.client('s3', **RUSTFS_CONFIG)
