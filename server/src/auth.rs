use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct UserClaims {
    pub sub: i64, // user id
    pub phone: String,
    pub exp: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AdminClaims {
    pub sub: i64,
    pub username: String,
    pub tv: i64, // token_version (for revocation)
    pub exp: i64,
}

pub fn issue_user_token(secret: &str, uid: i64, phone: &str) -> String {
    let claims = UserClaims {
        sub: uid,
        phone: phone.to_string(),
        exp: (Utc::now() + Duration::days(30)).timestamp(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

pub fn issue_admin_token(secret: &str, id: i64, username: &str, tv: i64) -> String {
    let claims = AdminClaims {
        sub: id,
        username: username.to_string(),
        tv,
        exp: (Utc::now() + Duration::hours(12)).timestamp(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

fn bearer(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.strip_prefix("Bearer ")
                .or_else(|| s.strip_prefix("bearer "))
        })
        .map(|s| s.trim().to_string())
}

/// Authenticated desktop user.
pub struct AuthUser(pub UserClaims);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or_else(|| AppError::unauthorized("缺少登录凭证"))?;
        let data = decode::<UserClaims>(
            &token,
            &DecodingKey::from_secret(state.cfg.user_jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| AppError::unauthorized("登录已失效，请重新登录"))?;
        Ok(AuthUser(data.claims))
    }
}

/// Authenticated admin (separate signing key + token_version check).
pub struct AuthAdmin(pub AdminClaims);

impl FromRequestParts<AppState> for AuthAdmin {
    type Rejection = AppError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or_else(|| AppError::unauthorized("缺少管理员凭证"))?;
        let data = decode::<AdminClaims>(
            &token,
            &DecodingKey::from_secret(state.cfg.admin_jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| AppError::unauthorized("管理员登录已失效"))?;
        // Enforce token_version for revocation.
        let tv: Option<i64> = sqlx::query_scalar("SELECT token_version FROM admins WHERE id = ?")
            .bind(data.claims.sub)
            .fetch_optional(&state.db)
            .await
            .map_err(|_| AppError::internal("db"))?;
        match tv {
            Some(v) if v == data.claims.tv => Ok(AuthAdmin(data.claims)),
            _ => Err(AppError::unauthorized("管理员登录已失效")),
        }
    }
}
