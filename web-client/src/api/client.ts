import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('fc_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto logout on 401
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('fc_token');
      localStorage.removeItem('fc_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
  register: (name: string, email: string, password: string) =>
    api.post('/auth/register', { name, email, password, role: 'REPORTER' }),
  savePushToken: (token: string) =>
    api.patch('/auth/push-token', { expoPushToken: token }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
  join: (id: string) => api.patch(`/conferences/${id}/participants/join`),
  getLiveKitToken: (id: string) => api.post(`/conferences/${id}/livekit-token`),
  create: (title: string, description?: string) =>
    api.post('/conferences', { title, description }),
  end: (id: string) => api.patch(`/conferences/${id}/end`),
};

export const participantsApi = {
  add: (conferenceId: string, userId: string, role: string, settings?: object) =>
    api.post(`/conferences/${conferenceId}/participants`, { userId, role, ...settings }),
  remove: (conferenceId: string, userId: string) =>
    api.delete(`/conferences/${conferenceId}/participants/${userId}`),
};

export const usersApi = {
  list: () => api.get('/users'),
  updateRole: (id: string, role: string) =>
    api.patch(`/users/${id}/role`, { role }),
};
