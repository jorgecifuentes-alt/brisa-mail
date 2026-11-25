/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { instrumentationHook: true, serverComponentsExternalPackages: ['imapflow', 'mailparser', 'nodemailer', 'web-push'] },
};
export default nextConfig;
