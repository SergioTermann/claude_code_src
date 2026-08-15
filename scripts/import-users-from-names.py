#!/usr/bin/env python3
import argparse
import csv
import hashlib
import sqlite3
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Import users from names.csv into chat_users.db')
    parser.add_argument('--csv', default='names.csv', help='CSV path, default: names.csv')
    parser.add_argument(
        '--db',
        action='append',
        default=[],
        help='SQLite database path. Can be passed multiple times.',
    )
    parser.add_argument(
        '--password',
        choices=['username'],
        default='username',
        help='Initial password rule for new users. Default: username',
    )
    args = parser.parse_args()

    db_paths = args.db or [
        'hn/chat_users.db',
        'hn/dify_webserver_project_py313_minimal/chat_users.db',
    ]
    users, duplicates = read_users(Path(args.csv))
    print(f'[users] csv rows={sum(1 for _ in open(args.csv, "rb").read().splitlines() if _.strip())} unique={len(users)} duplicates={len(duplicates)}')
    for username, names in duplicates:
        print(f'[users] duplicate ignored: {username} -> {" / ".join(names)}')

    for db_path in db_paths:
        result = import_users(Path(db_path), users)
        print(
            f'[users] {db_path}: inserted={result["inserted"]} '
            f'updated_names={result["updated"]} existing={result["existing"]}'
        )


def read_users(csv_path):
    rows = []
    with csv_path.open('r', encoding='gbk', newline='') as handle:
        for row in csv.reader(handle):
            if not row or not row[0].strip():
                continue
            username = row[0].strip()
            name = row[1].strip() if len(row) > 1 and row[1].strip() else username
            rows.append((username, name))

    users = {}
    duplicate_names = {}
    for username, name in rows:
        if username in users:
            duplicate_names.setdefault(username, [users[username]]).append(name)
            continue
        users[username] = name
    return users, sorted(duplicate_names.items())


def import_users(db_path, users):
    if not db_path.exists():
        raise FileNotFoundError(db_path)

    conn = sqlite3.connect(str(db_path))
    try:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        ensure_schema(cursor)
        inserted = 0
        updated = 0
        existing = 0
        for username, name in users.items():
            cursor.execute('SELECT id, name FROM users WHERE username = ?', (username,))
            row = cursor.fetchone()
            if row:
                existing += 1
                if (row['name'] or '') != name:
                    cursor.execute('UPDATE users SET name = ? WHERE id = ?', (name, row['id']))
                    updated += 1
                continue

            cursor.execute(
                'INSERT INTO users (username, password, name, is_admin) VALUES (?, ?, ?, 0)',
                (username, legacy_hash_password(username), name),
            )
            inserted += 1
        conn.commit()
        return {'inserted': inserted, 'updated': updated, 'existing': existing}
    finally:
        conn.close()


def ensure_schema(cursor):
    cursor.execute(
        '''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        '''
    )
    columns = {row[1] for row in cursor.execute('PRAGMA table_info(users)').fetchall()}
    if 'name' not in columns:
        cursor.execute('ALTER TABLE users ADD COLUMN name TEXT')
    if 'is_admin' not in columns:
        cursor.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
    cursor.execute("UPDATE users SET name = username WHERE name IS NULL OR TRIM(name) = ''")


def legacy_hash_password(password):
    return hashlib.sha256(str(password).strip().encode()).hexdigest()


if __name__ == '__main__':
    main()
