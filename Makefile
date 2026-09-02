.PHONY: install test lint typecheck format prepush doctor seed

install:
	npm install

test:
	npm test

lint:
	npm run lint

typecheck:
	npm run typecheck

format:
	npm run format

# Run before pushing: formatting, linting, type checking, tests.
prepush: format lint typecheck test

doctor:
	npm run doctor

seed:
	npm run seed
