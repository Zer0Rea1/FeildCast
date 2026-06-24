import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(config => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) {
    localStorage.removeItem('admin_token');
    window.location.href = '/login';
  }
  return Promise.reject(err);
});

export default api;

export const authApi = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),
};

export const conferencesApi = {
  list: () => api.get('/conferences'),
  get: (id: string) => api.get(`/conferences/${id}`),
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
};
