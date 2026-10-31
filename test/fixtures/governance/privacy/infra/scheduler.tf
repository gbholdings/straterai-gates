resource "google_cloud_scheduler_job" "purge_sessions" {
  name     = "purge-sessions"
  schedule = "17 3 * * *"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/purge-sessions:run"
    http_method = "POST"
  }
}

resource "google_cloud_scheduler_job" "purge_people" {
  name     = "purge-inactive-people"
  schedule = "41 3 * * 0"
  http_target {
    uri         = "https://run.googleapis.com/v2/projects/example-project/locations/us-central1/jobs/purge-inactive-people:run"
    http_method = "POST"
  }
}
