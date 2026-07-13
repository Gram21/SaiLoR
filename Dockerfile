# syntax=docker/dockerfile:1

# ---- Build stage: compile the static SPA ----
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Build the browser bundle into /app/dist.
COPY . .
RUN npm run build

# ---- Runtime stage: serve the static files with nginx ----
FROM nginx:1.27-alpine AS runtime

# SPA-aware nginx config (index fallback + asset caching).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The built SPA.
COPY --from=build /app/dist /usr/share/nginx/html

# Projects (JSON + pdfs/) are mounted here at runtime; see docker-compose.yml.
# Create the directory so the mount target always exists.
RUN mkdir -p /usr/share/nginx/html/projects

EXPOSE 80

# Use 127.0.0.1 (not "localhost", which may resolve to IPv6 [::1] where nginx
# does not listen) so the healthcheck reliably reaches the IPv4 listener.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
