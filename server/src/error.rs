use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        AppError {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", msg)
    }
    pub fn unauthorized(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", msg)
    }
    pub fn quota(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYMENT_REQUIRED, "quota_exceeded", msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", msg)
    }
    pub fn rate_limited(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", msg)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "error": { "code": self.code, "message": self.message } }));
        (self.status, body).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::internal(format!("db error: {e}"))
    }
}
impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::internal(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
