const identity = (value: unknown) => String(value);
identity.bold = identity;

const chalk = {
	blue: identity,
	yellow: identity,
	red: identity,
	green: identity,
	magenta: identity,
	cyan: identity,
	grey: identity
};

export default chalk;
