// A self-signed certificate issued for `pinned.example` and for nothing else,
// with its key. It exists so `pinning.test.ts` can prove that pinning the
// socket to an address did not stop the certificate being judged against the
// hostname — a self-signed pair generated once and embedded rather than
// produced at test time, because generating an X.509 certificate needs a
// dependency and this repository has none.
//
// It is a test double. It is trusted only inside the child process that test
// spawns, through NODE_EXTRA_CA_CERTS, and its private key is published here
// on purpose so nobody can mistake it for something that guards anything. It
// expires in 2126; if it ever verifies against a real host, something is very
// wrong elsewhere.

export const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIUWUREk/ZyqgS3dTjLwxez67IL/KUwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOcGlubmVkLmV4YW1wbGUwIBcNMjYwNzMxMDMwODMwWhgPMjEy
NjA3MDcwMzA4MzBaMBkxFzAVBgNVBAMMDnBpbm5lZC5leGFtcGxlMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEMJbRfIlGouueWq375IZxYD1fwpDtMLwCeWDagjKr
gBXNXCBMTo0H/53kQ6e9lbLSjlrTbvTy/Ftj9ORsPelEeKNuMGwwHQYDVR0OBBYE
FEfM3LHocfqZbFgd9Qu6KoCotODSMB8GA1UdIwQYMBaAFEfM3LHocfqZbFgd9Qu6
KoCotODSMA8GA1UdEwEB/wQFMAMBAf8wGQYDVR0RBBIwEIIOcGlubmVkLmV4YW1w
bGUwCgYIKoZIzj0EAwIDSAAwRQIhAJ8jlhG4puGMymOm4+PmD9WIpD7Kf+53XQi/
9aFT8X0EAiA1gxKmfgUP91w7RGBk49+oTlBRZtHIUlNN/FzzN/QfBQ==
-----END CERTIFICATE-----
`;

export const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1cd6PIeWhsvI12tI
1EM3mO3YSMxVQ0z6J0+aB47QYLihRANCAAQwltF8iUai655arfvkhnFgPV/CkO0w
vAJ5YNqCMquAFc1cIExOjQf/neRDp72VstKOWtNu9PL8W2P05Gw96UR4
-----END PRIVATE KEY-----
`;
