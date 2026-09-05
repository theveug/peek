CREATE TABLE device_settings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL,
  settings    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
