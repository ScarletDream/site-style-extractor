# License decision record

Status: **provisional until the first public release**.

The repository currently uses Apache License 2.0 because the intended beta favors
broad adoption by individuals, companies, and other Agent ecosystems while keeping
copyright notices and adding an express patent grant.

## What this choice permits

- Private and commercial use.
- Modification and redistribution, including inside closed-source products.
- Charging money for products or services that use the project.
- Forking the project without contributing changes upstream.

## What downstream distributors must do

- Include the Apache-2.0 license and relevant copyright/attribution notices.
- State significant changes to modified files.
- Preserve a `NOTICE` file if a distributed version contains one.
- Avoid implying that project or contributor trademarks endorse their product.

## What it does not protect

- It does not require forks, hosted services, or commercial derivatives to publish
  their source code.
- It does not license third-party websites, screenshots, fonts, brands, or assets
  captured by users.
- It does not transfer ownership of the project name or logo.
- It is not a warranty, support promise, or guarantee of legal compliance by users.

## Why not the closest alternatives

- MIT is simpler and similarly permissive, but has no equally explicit contributor
  patent grant.
- MPL-2.0 would require publication of modifications to MPL-covered files while
  allowing larger proprietary products; choose it if reciprocal engine fixes matter
  more than frictionless adoption.
- GPL-3.0 would require distributed combined derivatives to remain GPL; choose it
  only if strong code-sharing reciprocity is a product goal.
- AGPL-3.0 extends that reciprocity to modified network services and is the strongest
  deterrent to closed hosted forks, but creates the most adoption and legal-review
  friction.

Before publishing, the maintainer must explicitly choose between broad adoption
(Apache-2.0), file-level reciprocity (MPL-2.0), or strong/network reciprocity
(GPL-3.0/AGPL-3.0). A public license grant for an already released version should be
treated as irreversible for recipients of that version.

This record explains project intent; the actual `LICENSE` text controls and this is
not legal advice.
